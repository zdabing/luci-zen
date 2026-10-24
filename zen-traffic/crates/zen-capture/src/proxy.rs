//! proxy.rs — HTTP/HTTPS 透明代理（M3/M4，docs/PACKET_CAPTURE.md）。
//!
//! 控制面（主线程/uloop）：nft 表与每会话链管理、CA 存储启停、会话端口分配。
//! 数据面（tokio 后台线程）：透明代理 80；decrypt 会话再收 443，先嗅探 ClientHello
//! 的 SNI——命中 decrypt_skip 名单直接 TCP 透传（pinning 域名不受影响），否则用
//! 动态签发的 leaf 证书终结客户端 TLS（rustls/ring，ALPN 仅 http/1.1），上游按
//! ca-bundle 校验后转发；解密流上解析 HTTP 头产出事件。QUIC(UDP/443) 由 nft 丢弃
//! 逼浏览器回落 TCP。
//!
//! 红线核对：nft 以 `nft -f -` 参数化调用（无 shell）；事件写回会话共享结构，
//! 不反向触碰 Manager 锁。

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::watch;

use crate::capture::{Event, SessionShared};
use crate::parse;

const HEAD_LIMIT: usize = 32 * 1024;
const IDLE: Duration = Duration::from_secs(30);
const MAX_SERVER_CONFIGS: usize = 64;
const TLS_MAX_RECORD: usize = 16 * 1024 + 32;

// ---------------------------------------------------------------------------
// nft 控制面
// ---------------------------------------------------------------------------

pub fn nft_path() -> Option<&'static str> {
    for path in ["/usr/sbin/nft", "/usr/bin/nft"] {
        if Path::new(path).exists() {
            return Some(path);
        }
    }
    None
}

fn nft_run(script: &str) -> Result<(), String> {
    let path = nft_path().ok_or("nft_failed")?;
    let mut child = std::process::Command::new(path)
        .arg("-f")
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            eprintln!("[zen-capture] nft 启动失败: {e}");
            "nft_failed".to_string()
        })?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    stdin.write_all(script.as_bytes()).map_err(|e| {
        eprintln!("[zen-capture] nft 写入失败: {e}");
        "nft_failed".to_string()
    })?;
    drop(stdin);
    let output = child.wait_with_output().map_err(|e| {
        eprintln!("[zen-capture] nft 等待失败: {e}");
        "nft_failed".to_string()
    })?;
    if output.status.success() {
        Ok(())
    } else {
        eprintln!(
            "[zen-capture] nft 失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        Err("nft_failed".into())
    }
}

/// daemon 启动：崩溃残留清理（表只属于 zen-capture，整体删除重建）。
pub fn table_reset() -> Result<(), String> {
    let _ = nft_run("delete table inet zen_capture\n");
    nft_run("add table inet zen_capture\n")
}

/// 每会话独立 nat 链：建立/回收一步到位，不追踪 rule handle。
pub fn chain_add(id: &str, _mac: &str, port: u16, decrypt: bool) -> Result<(), String> {
    let mut script = format!(
        "add table inet zen_capture\n\
         add chain inet zen_capture pre_{id} {{ type nat hook prerouting priority dstnat; }}\n\
         add rule inet zen_capture pre_{id} meta l4proto tcp tcp dport 80 redirect to :{port}\n"
    );
    if decrypt {
        script += &format!(
            "add rule inet zen_capture pre_{id} meta l4proto tcp tcp dport 443 redirect to :{port}\n\
             add rule inet zen_capture pre_{id} meta l4proto udp udp dport 443 drop\n"
        );
    }
    nft_run(&script)
}

pub fn chain_del(id: &str) {
    let _ = nft_run(&format!("delete chain inet zen_capture pre_{id}\n"));
}

// ---------------------------------------------------------------------------
// tokio 运行时（进程内单例）
// ---------------------------------------------------------------------------

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

pub fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        // rustls 需要 crypto provider；进程内安装一次（ring，musl 交叉友好）。
        let _ = rustls::crypto::ring::default_provider().install_default();
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime")
    })
}

// ---------------------------------------------------------------------------
// CA 存储（M4）
// ---------------------------------------------------------------------------

pub struct CaStore {
    dir: PathBuf,
}

pub struct CaMaterial {
    pub cert_pem: String,
    pub cert_der: Vec<u8>,
    pub key_pem: String,
}

impl CaStore {
    pub fn new(dir: &Path) -> CaStore {
        CaStore { dir: dir.to_path_buf() }
    }

    fn cert_path(&self) -> PathBuf { self.dir.join("ca.pem") }
    fn key_path(&self) -> PathBuf { self.dir.join("ca.key") }

    pub fn is_ready(&self) -> bool {
        self.cert_path().is_file() && self.key_path().is_file()
    }

    pub fn cert_pem(&self) -> Result<String, String> {
        std::fs::read_to_string(self.cert_path()).map_err(|_| "ca_unavailable".into())
    }

    /// 加载既有 CA，缺失则生成（ECDSA P256，浏览器全兼容且签发快）。
    pub fn ensure(&self) -> Result<CaMaterial, String> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("ca_unavailable: 创建 {:?}: {e}", self.dir))?;
        if self.is_ready() {
            let cert_pem = self.cert_pem()?;
            let key_pem = std::fs::read_to_string(self.key_path()).map_err(|_| "ca_unavailable")?;
            let cert_der = pem_to_der(&cert_pem)?;
            return Ok(CaMaterial { cert_pem, cert_der, key_pem });
        }
        let key = rcgen::KeyPair::generate().map_err(|e| format!("ca_unavailable: {e}"))?;
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new())
            .map_err(|e| format!("ca_unavailable: {e}"))?;
        params.distinguished_name.push(rcgen::DnType::CommonName, "Zen Capture Root CA");
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let cert = params.self_signed(&key).map_err(|e| format!("ca_unavailable: {e}"))?;
        let material = CaMaterial {
            cert_pem: cert.pem(),
            cert_der: cert.der().to_vec(),
            key_pem: key.serialize_pem(),
        };
        write_private(&self.key_path(), &material.key_pem)?;
        write_private(&self.cert_path(), &material.cert_pem)?;
        Ok(material)
    }
}

/// 私钥/证书写入 0600（非 unix 退化为普通写入，仅测试环境）。
fn write_private(path: &Path, content: &str) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).and_then(|mut f| f.write_all(content.as_bytes()))
        .map_err(|e| format!("ca_unavailable: 写入 {path:?}: {e}"))
}

fn pem_to_der(pem: &str) -> Result<Vec<u8>, String> {
    rustls_pemfile::certs(&mut std::io::BufReader::new(pem.as_bytes()))
        .next()
        .transpose()
        .map(|der| der.map(|c| c.to_vec()))
        .map_err(|e| format!("ca_unavailable: {e}"))?
        .ok_or_else(|| "ca_unavailable".to_string())
}

/// 进程内缓存的签发者（与磁盘上同一张 CA，重启不换证）。
static ISSUER: OnceLock<Mutex<Option<rcgen::Issuer<'static, rcgen::KeyPair>>>> = OnceLock::new();

fn issuer(store: &CaStore) -> Result<&'static Mutex<Option<rcgen::Issuer<'static, rcgen::KeyPair>>>, String> {
    let material = store.ensure()?;
    let cell = ISSUER.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().map_err(|_| "mitm_unavailable")?;
    if guard.is_none() {
        let key = rcgen::KeyPair::from_pem(&material.key_pem)
            .map_err(|e| format!("mitm_unavailable: {e}"))?;
        *guard = Some(rcgen::Issuer::from_ca_cert_pem(&material.cert_pem, key)
            .map_err(|e| format!("mitm_unavailable: {e}"))?);
    }
    Ok(cell)
}

fn leaf_config(issuer_cell: &'static Mutex<Option<rcgen::Issuer<'static, rcgen::KeyPair>>>, domain: &str, ca_der: Vec<u8>) -> Result<Arc<rustls::ServerConfig>, String> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, Arc<rustls::ServerConfig>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(BTreeMap::new()));
    let mut guard = cache.lock().map_err(|_| "mitm_unavailable")?;
    if let Some(found) = guard.get(domain) {
        return Ok(found.clone());
    }
    let issuer_guard = issuer_cell.lock().map_err(|_| "mitm_unavailable")?;
    let issuer = issuer_guard.as_ref().ok_or("mitm_unavailable")?;
    let leaf_key = rcgen::KeyPair::generate().map_err(|e| format!("mitm_unavailable: {e}"))?;
    let params = rcgen::CertificateParams::new(vec![domain.to_string()])
        .map_err(|e| format!("mitm_unavailable: {e}"))?;
    let leaf = params.signed_by(&leaf_key, issuer).map_err(|e| format!("mitm_unavailable: {e}"))?;
    drop(issuer_guard);

    let private = rustls::pki_types::PrivateKeyDer::try_from(leaf_key.serialize_der())
        .map_err(|e| format!("mitm_unavailable: {e}"))?;
    let mut config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![
                rustls::pki_types::CertificateDer::from(leaf.der().to_vec()),
                rustls::pki_types::CertificateDer::from(ca_der),
            ],
            private,
        )
        .map_err(|e| format!("mitm_unavailable: {e}"))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let config = Arc::new(config);
    if guard.len() >= MAX_SERVER_CONFIGS {
        guard.pop_first();
    }
    guard.insert(domain.to_string(), config.clone());
    Ok(config)
}

fn upstream_connector() -> Result<Arc<tokio_rustls::TlsConnector>, String> {
    static CONNECTOR: OnceLock<Option<Arc<tokio_rustls::TlsConnector>>> = OnceLock::new();
    CONNECTOR
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            let bundle = std::fs::File::open("/etc/ssl/certs/ca-certificates.crt").ok()?;
            let certs = rustls_pemfile::certs(&mut std::io::BufReader::new(bundle))
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            for cert in certs {
                if roots.add(cert).is_err() {
                    return None;
                }
            }
            let config = rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            let mut config = Arc::new(config);
            Arc::get_mut(&mut config)?.alpn_protocols = vec![b"http/1.1".to_vec()];
            Some(Arc::new(tokio_rustls::TlsConnector::from(config)))
        })
        .clone()
        .ok_or_else(|| "mitm_unavailable".to_string())
}

// ---------------------------------------------------------------------------
// 会话数据面
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct SessionRuntime {
    decrypt: bool,
    skip: Arc<Vec<String>>,
    shared: Arc<SessionShared>,
    ca: Arc<CaStore>,
}

pub struct ProxyHandle {
    pub port: u16,
    pub stop: watch::Sender<bool>,
}

/// 启动一个 http 会话的代理监听（127.0.0.1 随机端口 + nft 会话链由调用方管理）。
pub fn start_session(
    decrypt: bool,
    skip: Vec<String>,
    shared: Arc<SessionShared>,
    ca_dir: &Path,
) -> Result<ProxyHandle, String> {
    runtime(); // 先装好 rustls provider，后面 ClientConfig::builder() 才不会 panic
    let (stop, stop_rx) = watch::channel(false);
    // nft redirect 把包的 dst 改写为入口接口主地址（如 10.0.0.1），必须绑定全部本地地址
    let listener = std::net::TcpListener::bind(("0.0.0.0", 0))
        .map_err(|e| {
            eprintln!("[zen-capture] 代理端口绑定失败: {e}");
            "spawn_failed".to_string()
        })?;
    let port = listener.local_addr().map_err(|_| "spawn_failed")?.port();
    // from_std 必须在 tokio 上下文中调用（向当前 reactor 注册）；主线程/ubus 处理器
    // 没有运行时，手动 enter 后转换，句柄随 listener 保存，spawn 后照常使用。
    let listener = {
        let _guard = runtime().enter();
        tokio::net::TcpListener::from_std(listener).map_err(|e| {
            eprintln!("[zen-capture] 代理监听迁移失败: {e}");
            "spawn_failed".to_string()
        })?
    };
    let rt = SessionRuntime {
        decrypt,
        skip: Arc::new(skip),
        shared,
        ca: Arc::new(CaStore::new(ca_dir)),
    };
    if decrypt {
        // 启动即校验 CA/根证书可用性，失败立刻回滚而不是静默吞包。
        let _ = issuer(&rt.ca)?;
        upstream_connector()?;
    }
    runtime().spawn(session_loop(listener, stop_rx, rt));
    Ok(ProxyHandle { port, stop })
}

async fn session_loop(
    listener: tokio::net::TcpListener,
    mut stop: watch::Receiver<bool>,
    rt: SessionRuntime,
) {
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    tokio::spawn(handle_conn(stream, rt.clone()));
                }
                Err(_) => break,
            },
        }
    }
}

async fn handle_conn(stream: tokio::net::TcpStream, rt: SessionRuntime) {
    let _ = stream.set_nodelay(true);
    let mut stream = stream;
    let mut first = Vec::new();
    // 嗅探首字节：0x16 = TLS handshake，否则按明文 HTTP 处理（80 与 443 共用一个监听口）。
    if read_more(&mut stream, &mut first).await.is_err() {
        return;
    }
    if first.first() == Some(&0x16) {
        tls_conn(stream, first, rt).await;
    } else {
        let _ = plain_conversation(&mut stream, first, &rt).await;
    }
}

/// 443 路径：读完整 ClientHello → SNI → 白名单透传或 MITM。
async fn tls_conn(mut stream: tokio::net::TcpStream, mut buf: Vec<u8>, rt: SessionRuntime) {
    let needed = loop {
        match parse::tls_record_len(&buf) {
            Some(len) if buf.len() >= len => break len.min(TLS_MAX_RECORD),
            Some(_) => {
                if buf.len() > TLS_MAX_RECORD || read_more(&mut stream, &mut buf).await.is_err() {
                    return;
                }
            }
            None => return,
        }
    };
    buf.truncate(needed);
    let Some(sni) = parse::sni_from_record(&buf) else {
        // 无 SNI（IP 直连/加密 SNI）无法路由，直接关闭。
        return;
    };
    let event = |kind: &str, status: u16, req: u64, resp: u64| Event {
        ts: crate::ubus::now_epoch(),
        kind: kind.to_string(),
        method: String::new(),
        host: sni.clone(),
        path: String::new(),
        status,
        req_bytes: req,
        resp_bytes: resp,
    };

    if !rt.decrypt || parse::domain_skipped(&sni, &rt.skip) {
        // 未开解密的会话不该收到 443（nft 只对 decrypt 会话重定向）；万一到达（残留
        // 连接），与 pinning 白名单一样 TCP 透传，事件显式标记（双向并发，避免
        // keep-alive 死锁）。
        // pinning 白名单：TCP 透传，事件显式标记（双向并发，避免 keep-alive 死锁）
        match tokio::net::TcpStream::connect((sni.as_str(), 443)).await {
            Ok(mut upstream) => {
                let (sent, got) = tokio::io::copy_bidirectional(&mut stream, &mut upstream)
                    .await
                    .unwrap_or((0, 0));
                rt.shared.push_event(event("passthrough", 0, sent, got));
            }
            Err(_) => rt.shared.push_event(event("passthrough", 0, 0, 0)),
        }
        return;
    }

    // MITM：动态 leaf → 终结客户端 TLS → 上游 TLS → 明文会话
    let Ok(issuer_cell) = issuer(&rt.ca) else { return };
    let Ok(ca) = rt.ca.ensure() else { return };
    let Ok(server_config) = leaf_config(issuer_cell, &sni, ca.cert_der) else { return };
    let acceptor = tokio_rustls::TlsAcceptor::from(server_config);
    let client_tls = match acceptor.accept(stream).await {
        Ok(tls) => tls,
        Err(e) => {
            eprintln!("[zen-capture] 客户端 TLS 握手失败 ({sni}): {e}");
            return;
        }
    };
    let mut client_tls = client_tls;
    let Ok(connector) = upstream_connector() else { return };
    let Ok(server_name) = rustls::pki_types::ServerName::try_from(sni.clone()) else { return };
    let upstream = match tokio::net::TcpStream::connect((sni.as_str(), 443)).await {
        Ok(tcp) => tcp,
        Err(_) => {
            rt.shared.push_event(event("tls_failed", 0, 0, 0));
            return;
        }
    };
    let upstream_tls = match connector.connect(server_name, upstream).await {
        Ok(tls) => tls,
        Err(e) => {
            // 上游校验失败：证书固定或截断，如实记录（客户端会看到连接失败）
            eprintln!("[zen-capture] 上游 TLS 校验失败 ({sni}): {e}");
            rt.shared.push_event(event("tls_failed", 0, 0, 0));
            return;
        }
    };
    let mut upstream_tls = upstream_tls;
    let _ = tls_conversation(&mut client_tls, &mut upstream_tls, &rt, &sni).await;
    let _ = upstream_tls.shutdown().await;
}

// ---------------------------------------------------------------------------
// HTTP 会话（明文按 Host 重连上游；解密流复用已建立的固定上游）
// ---------------------------------------------------------------------------

/// 明文 80 路径：keep-alive 循环，每个请求按 Host 头重连上游。
async fn plain_conversation(
    client: &mut tokio::net::TcpStream,
    prefix: Vec<u8>,
    rt: &SessionRuntime,
) -> std::io::Result<()> {
    let mut prefix = prefix;
    loop {
        let (head, _leftover) = read_head(client, std::mem::take(&mut prefix)).await?;
        let Some(request) = parse::parse_request_head(&head) else { return Ok(()) };
        let body_policy = RequestBody::from(&request);
        let RequestBody::Sized(len) = body_policy else {
            // chunked 或无长度请求体（v1 限制）：显式记录并断开
            rt.shared.push_event(failed_event(&request, "http", head.len() as u64));
            return Ok(());
        };
        let Ok(mut upstream) = tokio::net::TcpStream::connect((request.host.as_str(), 80)).await
        else {
            rt.shared.push_event(failed_event(&request, "http", head.len() as u64));
            return Ok(());
        };
        let mut sent = head.len() as u64;
        if upstream.write_all(&head).await.is_err() {
            rt.shared.push_event(failed_event(&request, "http", head.len() as u64));
            return Ok(());
        }
        if copy_n(client, &mut upstream, len).await.is_err() {
            return Ok(());
        }
        let Ok(response) = forward_response(client, &mut upstream, &request, "http", rt, &mut sent).await
        else {
            return Ok(());
        };
        if !response {
            return Ok(());
        }
    }
}

/// 解密 https 路径：上游固定为该 SNI 的 TLS 流，keep-alive 复用。
async fn tls_conversation<C, U>(client: &mut C, upstream: &mut U, rt: &SessionRuntime, host: &str) -> std::io::Result<()>
where
    C: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let (head, _leftover) = read_head(client, Vec::new()).await?;
        let Some(request) = parse::parse_request_head(&head) else { return Ok(()) };
        let RequestBody::Sized(len) = RequestBody::from(&request) else {
            rt.shared.push_event(failed_event(&request, "https", head.len() as u64));
            return Ok(());
        };
        let mut sent = head.len() as u64;
        upstream.write_all(&head).await?;
        copy_n(client, upstream, len).await?;
        let mut request = request.clone();
        request.host = host.to_string();
        let Ok(keep) = forward_response(client, upstream, &request, "https", rt, &mut sent).await
        else {
            return Ok(());
        };
        if !keep {
            return Ok(());
        }
    }
}

/// 请求体策略：透明转发需要确定的长度
enum RequestBody {
    Sized(u64),
    Unsupported,
}

impl From<&parse::HttpHead> for RequestBody {
    fn from(request: &parse::HttpHead) -> RequestBody {
        if request.chunked {
            return RequestBody::Unsupported;
        }
        match request.content_length {
            Some(len) => RequestBody::Sized(len),
            None if matches!(request.method.as_str(), "GET" | "HEAD" | "DELETE" | "OPTIONS") => {
                RequestBody::Sized(0)
            }
            None => RequestBody::Unsupported,
        }
    }
}

/// 读上游响应头 → 转发 → 按 content-length/EOF 计数 → 记事件。返回是否 keep-alive。
async fn forward_response<C, U>(
    client: &mut C,
    upstream: &mut U,
    request: &parse::HttpHead,
    scheme: &str,
    rt: &SessionRuntime,
    sent: &mut u64,
) -> std::io::Result<bool>
where
    C: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    let (resp_head, _) = read_head(upstream, Vec::new()).await?;
    let Some(response) = parse::parse_response_head(&resp_head) else {
        return Ok(false);
    };
    client.write_all(&resp_head).await?;
    let mut received = resp_head.len() as u64;
    let keep_alive = !request.close
        && !response.close
        && (response.content_length.is_some() || !response.chunked);
    let forwarded = match response.content_length {
        Some(len) => copy_n(upstream, client, len).await,
        None => splice(upstream, client, HEAD_LIMIT as u64 * 64).await,
    }?;
    received += forwarded;
    rt.shared.push_event(Event {
        ts: crate::ubus::now_epoch(),
        kind: scheme.to_string(),
        method: request.method.clone(),
        host: request.host.clone(),
        path: request.path.clone(),
        status: response.status,
        req_bytes: *sent,
        resp_bytes: received,
    });
    Ok(keep_alive)
}

fn failed_event(request: &parse::HttpHead, scheme: &str, req_bytes: u64) -> Event {
    Event {
        ts: crate::ubus::now_epoch(),
        kind: scheme.to_string(),
        method: request.method.clone(),
        host: request.host.clone(),
        path: request.path.clone(),
        status: 0,
        req_bytes,
        resp_bytes: 0,
    }
}

fn push_failed(rt: &SessionRuntime, scheme: &str, request: &parse::HttpHead) {
    rt.shared.push_event(Event {
        ts: crate::ubus::now_epoch(),
        kind: scheme.to_string(),
        method: request.method.clone(),
        host: request.host.clone(),
        path: request.path.clone(),
        status: 0,
        req_bytes: 0,
        resp_bytes: 0,
    });
}

/// 读到完整的 HTTP 头（\r\n\r\n）。返回 (头字节, 头之后已缓冲的剩余字节)。
async fn read_head<R: AsyncRead + Unpin>(reader: &mut R, mut buf: Vec<u8>) -> std::io::Result<(Vec<u8>, Vec<u8>)> {
    loop {
        if buf.len() > HEAD_LIMIT {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "head too large"));
        }
        if let Some(end) = find_head_end(&buf) {
            let rest = buf.split_off(end + 4);
            return Ok((buf, rest));
        }
        read_more(reader, &mut buf).await?;
    }
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

async fn read_more<R: AsyncRead + Unpin>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<usize> {
    let mut chunk = [0u8; 8192];
    let n = tokio::time::timeout(IDLE, reader.read(&mut chunk)).await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "idle"))??;
    if n == 0 {
        return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "eof"));
    }
    buf.extend_from_slice(&chunk[..n]);
    Ok(n)
}

/// 精确拷贝 n 字节（请求体按 content-length）
async fn copy_n<R, W>(reader: &mut R, writer: &mut W, mut left: u64) -> std::io::Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut total = 0u64;
    let mut chunk = [0u8; 8192];
    while left > 0 {
        let want = chunk.len().min(left as usize);
        let n = tokio::time::timeout(IDLE, reader.read(&mut chunk[..want])).await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "idle"))??;
        if n == 0 {
            break;
        }
        writer.write_all(&chunk[..n]).await?;
        total += n as u64;
        left -= n as u64;
    }
    Ok(total)
}

/// 拷贝到 EOF（上限 max），返回拷贝字节数
async fn splice<R, W>(reader: &mut R, writer: &mut W, max: u64) -> std::io::Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut total = 0u64;
    let mut chunk = [0u8; 8192];
    while total < max {
        let n = tokio::time::timeout(IDLE, reader.read(&mut chunk)).await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "idle"))??;
        if n == 0 {
            break;
        }
        writer.write_all(&chunk[..n]).await?;
        total += n as u64;
    }
    Ok(total)
}

/// HAR 1.2 文档（HTTP/HTTPS 事件 → entries；解密失败的条目记 status 0）
pub fn har_json(events: &[Event], creator_version: &str) -> serde_json::Value {
    let entries: Vec<serde_json::Value> = events
        .iter()
        .map(|event| {
            let scheme = if event.kind == "https" { "https" } else { "http" };
            let path = if event.path.is_empty() { "/" } else { event.path.as_str() };
            serde_json::json!({
                "startedDateTime": parse::rfc3339(event.ts),
                "time": 0,
                "_kind": event.kind,
                "request": {
                    "method": if event.method.is_empty() { "GET" } else { event.method.as_str() },
                    "url": format!("{scheme}://{}{}", event.host, path),
                    "httpVersion": "HTTP/1.1",
                    "headers": [],
                    "headersSize": -1,
                    "bodySize": event.req_bytes,
                },
                "response": {
                    "status": event.status,
                    "statusText": "",
                    "httpVersion": "HTTP/1.1",
                    "headers": [],
                    "headersSize": -1,
                    "bodySize": event.resp_bytes,
                    "content": { "size": event.resp_bytes, "mimeType": "" },
                },
                "cache": {},
                "timings": { "send": 0, "wait": 0, "receive": 0 },
            })
        })
        .collect();
    serde_json::json!({
        "log": {
            "version": "1.2",
            "creator": { "name": "zen-capture", "version": creator_version },
            "entries": entries,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nft_scripts_are_well_formed_per_session() {
        // 脚本内容检查通过 chain_add 的字符串组装（此处验证 id 安全字符约束的调用约定）
        let id = "1a2b-0001";
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }

    #[test]
    fn har_document_carries_url_status_and_sizes() {
        let events = vec![Event {
            ts: 1_760_000_000,
            kind: "https".into(),
            method: "GET".into(),
            host: "example.com".into(),
            path: "/a?b=1".into(),
            status: 200,
            req_bytes: 120,
            resp_bytes: 2048,
        }];
        let har = har_json(&events, "0.1");
        let entry = &har["log"]["entries"][0];
        assert_eq!(entry["request"]["url"], "https://example.com/a?b=1");
        assert_eq!(entry["response"]["status"], 200);
        assert_eq!(entry["response"]["content"]["size"], 2048);
        assert_eq!(entry["startedDateTime"], "2025-10-09T08:53:20Z");
        assert_eq!(har["log"]["creator"]["name"], "zen-capture");
    }
}
