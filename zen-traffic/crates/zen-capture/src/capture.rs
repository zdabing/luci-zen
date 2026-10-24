//! capture.rs — 会话状态机与进程/BPF/代理管理（docs/PACKET_CAPTURE.md）。
//!
//! 三种模式：`tap`（eBPF，pcap + 域名画像，默认）、`http`（透明代理，事件 + HAR，
//! 可选 decrypt MITM）、`tcpdump`（M1 fallback）。限额（时长/并发/保留）统一；
//! max_bytes 只约束 tap 模式的 pcap。进程交互收敛在 `Proc` trait、tcpdump 查找
//! 与 BPF 对象路径可注入，状态机可单测。

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, BufWriter, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::parse;
use crate::proxy;
use crate::tap::{self, TapEngine};

const REAP_ROUNDS: u32 = 10;
const REAP_SLEEP_MS: u64 = 100;
const DISK_FLOOR_BYTES: u64 = 8 * 1024 * 1024;
const SECONDS_MIN: u64 = 10;
const BYTES_MIN: u64 = 64 * 1024;
const SNAP_MIN: u32 = 24;
const SNAP_MAX: u32 = 262_144;
const EVENT_LIMIT: usize = 500;
const DOMAIN_LIMIT: usize = 500;
const DOMAIN_TOP: usize = 100;

#[derive(Clone, Debug)]
pub struct Config {
    pub dir: PathBuf,
    pub ifaces: Vec<String>,
    pub max_sessions: u32,
    pub max_duration: u64,
    pub max_file_mb: u64,
    pub snaplen: u32,
    pub keep: u32,
    /// zen_capture.bpf.o 路径（tap 模式）
    pub tap_obj: PathBuf,
    /// CA 存储目录（http+decrypt 模式）
    pub ca_dir: PathBuf,
    /// MITM 直连白名单（pinning 域名，后缀匹配）
    pub decrypt_skip: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Running,
    Done,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Tap,
    Http,
    Tcpdump,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub mac: String,
    pub mode: Mode,
    pub decrypt: bool,
    /// http 模式的本地代理端口（0 = 无）
    pub port: u16,
    pub ifaces: Vec<String>,
    pub files: Vec<PathBuf>,
    /// tcpdump 模式必须持久化：daemon 崩溃重启后据此收割孤儿。
    pub pids: Vec<u32>,
    pub started: u64,
    pub seconds: u64,
    pub max_bytes: u64,
    pub bytes: u64,
    pub state: State,
    pub stop_reason: String,
    #[serde(skip)]
    pub shared: Arc<SessionShared>,
    #[serde(skip)]
    pub proxy_stop: Option<watch::Sender<bool>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DomainStat {
    pub count: u64,
    pub last_ts: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub ts: u64,
    /// http | https | passthrough | tls_failed
    pub kind: String,
    pub method: String,
    pub host: String,
    pub path: String,
    pub status: u16,
    pub req_bytes: u64,
    pub resp_bytes: u64,
}

/// 会话内被代理线程与主线程共享的数据（事件 / 域名画像）。
#[derive(Default, Debug)]
pub struct SessionShared {
    events: Mutex<Vec<Event>>,
    domains: Mutex<BTreeMap<String, DomainStat>>,
}

impl SessionShared {
    pub fn new() -> Arc<SessionShared> {
        Arc::new(SessionShared::default())
    }

    pub fn push_event(&self, event: Event) {
        if let Ok(mut events) = self.events.lock() {
            if events.len() >= EVENT_LIMIT {
                events.remove(0);
            }
            events.push(event);
        }
    }

    pub fn add_domain(&self, domain: String, ts: u64) {
        if let Ok(mut domains) = self.domains.lock() {
            let entry = domains.entry(domain).or_insert(DomainStat { count: 0, last_ts: 0 });
            entry.count += 1;
            entry.last_ts = ts;
            if domains.len() > DOMAIN_LIMIT {
                if let Some(oldest) = domains.keys().next().cloned() {
                    domains.remove(&oldest);
                }
            }
        }
    }

    pub fn snapshot_events(&self) -> Vec<Event> {
        self.events.lock().map(|e| e.clone()).unwrap_or_default()
    }

    pub fn top_domains(&self, limit: usize) -> Vec<(String, DomainStat)> {
        let mut rows: Vec<(String, DomainStat)> = self
            .domains
            .lock()
            .map(|d| d.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        rows.sort_by(|a, b| b.1.count.cmp(&a.1.count).then(b.1.last_ts.cmp(&a.1.last_ts)).then(a.0.cmp(&b.0)));
        rows.truncate(limit);
        rows
    }
}

#[derive(Clone, Debug, Default)]
pub struct StartRequest {
    pub mac: String,
    pub mode: Option<Mode>,
    pub seconds: Option<u64>,
    pub max_bytes: Option<u64>,
    pub snap: Option<u32>,
    pub decrypt: Option<bool>,
}

/// 进程交互边界：真实实现走 fork/exec + kill/waitpid，测试用假实现记录调用。
/// `Send` 约束：Manager 存放在 ubus 模块的 static Mutex 中。
pub trait Proc: Send {
    fn spawn(&self, args: &[String], log: &Path) -> io::Result<u32>;
    /// 进程是否仍然存活（无法确认时按已退出处理，宁可少报不悬挂）。
    fn alive(&self, pid: u32) -> bool;
    fn term(&self, pid: u32);
    /// Some(exit)：已退出（0 = 正常退出，非 0 = 失败/被信号终止）；None：仍在运行。
    fn reap(&self, pid: u32) -> Option<i32>;
}

pub struct RealProc;

impl Proc for RealProc {
    fn spawn(&self, args: &[String], log: &Path) -> io::Result<u32> {
        let mut command = std::process::Command::new(&args[0]);
        command.args(&args[1..])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null());
        command.stderr(match fs::OpenOptions::new().create(true).append(true).open(log) {
            Ok(file) => std::process::Stdio::from(file),
            Err(_) => std::process::Stdio::null(),
        });
        Ok(command.spawn()?.id())
    }

    fn alive(&self, pid: u32) -> bool {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    fn term(&self, pid: u32) {
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    }

    fn reap(&self, pid: u32) -> Option<i32> {
        let mut status = 0;
        let rc = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) };
        if rc != pid as libc::pid_t {
            return None; // 运行中（rc==0）或非本进程子进程
        }
        Some(if libc::WIFEXITED(status) { libc::WEXITSTATUS(status) } else { 128 + libc::WTERMSIG(status) })
    }
}

pub fn find_tcpdump() -> Option<String> {
    let candidates = [Path::new("/usr/sbin/tcpdump"), Path::new("/usr/bin/tcpdump")];
    if let Some(found) = candidates.into_iter().find(|p| p.exists()) {
        return Some(found.to_string_lossy().into_owned());
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("tcpdump"))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

pub fn valid_mac(mac: &str) -> bool {
    let parts: Vec<&str> = mac.split(':').collect();
    if parts.len() != 6 || parts.iter().any(|p| p.len() != 2 || !p.bytes().all(|b| b.is_ascii_hexdigit())) {
        return false;
    }
    let bytes: Vec<u8> = parts.iter().map(|p| u8::from_str_radix(p, 16).unwrap_or(0)).collect();
    bytes[0] & 1 == 0 && bytes != [0; 6]
}

pub fn mac_bytes(mac: &str) -> Option<[u8; 6]> {
    let parts: Vec<&str> = mac.split(':').collect();
    if parts.len() != 6 {
        return None;
    }
    let mut out = [0u8; 6];
    for (index, part) in parts.iter().enumerate() {
        out[index] = u8::from_str_radix(part, 16).ok()?;
    }
    Some(out)
}

pub fn tcpdump_args(binary: &str, iface: &str, snaplen: u32, path: &Path, mac: &str) -> Vec<String> {
    [
        binary.to_owned(),
        "-i".into(), iface.to_owned(),
        "-s".into(), snaplen.to_string(),
        "-U".into(),
        "-w".into(), path.to_string_lossy().into_owned(),
        "ether".into(), "host".into(), mac.to_owned(),
    ].into()
}

pub fn clamp_seconds(requested: Option<u64>, max_duration: u64) -> u64 {
    requested.unwrap_or(max_duration).clamp(SECONDS_MIN, max_duration.max(SECONDS_MIN))
}

pub fn clamp_bytes(requested: Option<u64>, max_file_mb: u64) -> u64 {
    let cap = (max_file_mb * 1024 * 1024).max(BYTES_MIN);
    requested.unwrap_or(cap).clamp(BYTES_MIN, cap)
}

pub fn clamp_snap(requested: Option<u32>, default: u32) -> u32 {
    requested.unwrap_or(default).clamp(SNAP_MIN, SNAP_MAX)
}

/// 与 zen-trafficd topology 同款：网桥展开为成员端口（DSA 硬件交换下 br-lan 看不到端口间转发）。
pub fn expand_ifaces(configured: &[String]) -> Result<Vec<String>, String> {
    expand_with(configured, &|name| {
        let path = Path::new("/sys/class/net").join(name).join("brif");
        if !path.exists() {
            return Ok(None);
        }
        let entries = fs::read_dir(&path).map_err(|e| format!("读取 {path:?}: {e}"))?;
        let ports = entries
            .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取 {path:?}: {e}"))?;
        Ok(Some(ports))
    })
}

fn expand_with(
    configured: &[String],
    ports: &impl Fn(&str) -> Result<Option<Vec<String>>, String>,
) -> Result<Vec<String>, String> {
    fn expand(
        name: &str,
        depth: usize,
        ports: &impl Fn(&str) -> Result<Option<Vec<String>>, String>,
        out: &mut BTreeSet<String>,
    ) -> Result<(), String> {
        if depth > 8 {
            return Err("LAN 网桥层级过深".into());
        }
        match ports(name)? {
            Some(children) if !children.is_empty() => {
                for child in children { expand(&child, depth + 1, ports, out)?; }
            }
            // 空网桥保持可观测，直到 netifd 创建其端口。
            _ => { out.insert(name.to_owned()); }
        }
        Ok(())
    }
    let mut out = BTreeSet::new();
    for name in configured { expand(name, 0, ports, &mut out)?; }
    Ok(out.into_iter().collect())
}

fn session_id(now: u64, seq: u64) -> String {
    format!("{now:08x}-{seq:04x}")
}

fn file_bytes(files: &[PathBuf]) -> u64 {
    files.iter().filter_map(|f| fs::metadata(f).ok()).map(|m| m.len()).sum()
}

pub struct Manager {
    pub cfg: Config,
    proc: Box<dyn Proc>,
    sessions: Vec<Session>,
    seq: u64,
    dirty: bool,
    tap: Option<TapEngine>,
    /// tap 会话的 pcap 直写句柄（主线程独占）
    writers: BTreeMap<String, BufWriter<File>>,
}

impl Manager {
    pub fn init(cfg: Config) -> Result<Manager, String> {
        Manager::with_proc(cfg, Box::new(RealProc))
    }

    pub fn with_proc(cfg: Config, proc: Box<dyn Proc>) -> Result<Manager, String> {
        fs::create_dir_all(&cfg.dir).map_err(|e| format!("创建 {:?}: {e}", cfg.dir))?;
        let mut manager = Manager {
            cfg, proc, sessions: Vec::new(), seq: 0, dirty: false,
            tap: None, writers: BTreeMap::new(),
        };
        manager.load();
        manager.recover();
        manager.sweep_orphans();
        manager.save();
        Ok(manager)
    }

    fn store_path(&self) -> PathBuf { self.cfg.dir.join("sessions.json") }

    fn load(&mut self) {
        self.sessions = match fs::read(self.store_path()) {
            Ok(data) => serde_json::from_slice(&data).unwrap_or_else(|e| {
                eprintln!("[zen-capture] sessions.json 解析失败，忽略旧会话: {e}");
                Vec::new()
            }),
            Err(_) => Vec::new(),
        };
        self.seq = self.sessions.iter()
            .filter_map(|s| s.id.rsplit_once('-').and_then(|(_, n)| u64::from_str_radix(n, 16).ok()))
            .max().unwrap_or(0);
    }

    /// 上次运行遗留的 running 会话：收割 tcpdump 孤儿 / 停代理 / 停 tap 并标记 interrupted。
    fn recover(&mut self) {
        let ids: Vec<(String, Mode, String)> = self.sessions.iter()
            .filter(|s| s.state == State::Running)
            .map(|s| (s.id.clone(), s.mode, s.mac.clone()))
            .collect();
        for (id, mode, mac) in ids {
            match mode {
                Mode::Tcpdump => {
                    self.term_session(&id);
                    self.wait_reap(&id);
                }
                Mode::Http => {
                    if let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) {
                        if let Some(stop) = session.proxy_stop.take() {
                            let _ = stop.send(true);
                        }
                    }
                    proxy::chain_del(&id);
                }
                Mode::Tap => {
                    if let (Some(engine), Some(bytes)) = (self.tap.as_mut(), mac_bytes(&mac)) {
                        engine.disable(bytes);
                    }
                    self.writers.remove(&id);
                }
            }
            self.finalize(&id, "interrupted");
        }
    }

    /// 目录里没有会话记录引用的 pcap/log 是异常退出残留，直接清理。
    fn sweep_orphans(&mut self) {
        let referenced: BTreeSet<PathBuf> = self.sessions.iter()
            .flat_map(|s| s.files.iter().flat_map(|f| [f.clone(), f.with_extension("log")]))
            .chain([self.store_path()]).collect();
        let Ok(entries) = fs::read_dir(&self.cfg.dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if !referenced.contains(&path) && (name.ends_with(".pcap") || name.ends_with(".log")) {
                let _ = fs::remove_file(&path);
            }
        }
    }

    pub fn start(&mut self, req: &StartRequest, now: u64) -> Result<&Session, String> {
        self.start_with(req, now, find_tcpdump)
    }

    pub fn start_with(
        &mut self,
        req: &StartRequest,
        now: u64,
        find_binary: impl Fn() -> Option<String>,
    ) -> Result<&Session, String> {
        let mac = req.mac.trim().to_ascii_lowercase();
        if !valid_mac(&mac) {
            return Err("invalid_mac".into());
        }
        if self.sessions.iter().filter(|s| s.state == State::Running).count() >= self.cfg.max_sessions as usize {
            return Err("too_many_sessions".into());
        }
        if self.sessions.iter().any(|s| s.state == State::Running && s.mac == mac) {
            return Err("already_capturing".into());
        }
        let mode = req.mode.unwrap_or(Mode::Tap);
        if mode == Mode::Tcpdump && find_binary().is_none() {
            return Err("tcpdump_missing".into());
        }
        let ifaces = expand_ifaces(&self.cfg.ifaces)?;
        let seconds = clamp_seconds(req.seconds, self.cfg.max_duration);
        let max_bytes = clamp_bytes(req.max_bytes, self.cfg.max_file_mb);
        let snaplen = clamp_snap(req.snap, self.cfg.snaplen);
        let decrypt = req.decrypt.unwrap_or(false) && mode == Mode::Http;
        let id = session_id(now, self.seq + 1);
        let shared = SessionShared::new();

        let (files, pids, port, proxy_stop) = match mode {
            Mode::Tcpdump => {
                let binary = find_binary().ok_or("tcpdump_missing")?;
                let files: Vec<PathBuf> = ifaces.iter()
                    .map(|iface| self.cfg.dir.join(format!("{id}-{iface}.pcap"))).collect();
                let logs: Vec<PathBuf> = ifaces.iter()
                    .map(|iface| self.cfg.dir.join(format!("{id}-{iface}.log"))).collect();
                let mut pids = Vec::new();
                for (index, iface) in ifaces.iter().enumerate() {
                    let argv = tcpdump_args(&binary, iface, snaplen, &files[index], &mac);
                    match self.proc.spawn(&argv, &logs[index]) {
                        Ok(pid) => pids.push(pid),
                        Err(e) => {
                            eprintln!("[zen-capture] tcpdump({iface}) 启动失败: {e}");
                            for pid in pids.drain(..) { self.proc.term(pid); }
                            return Err("spawn_failed".into());
                        }
                    }
                }
                (files, pids, 0, None)
            }
            Mode::Tap => {
                let path = self.cfg.dir.join(format!("{id}.pcap"));
                self.start_tap(&id, &mac, &ifaces, &path)?;
                (vec![path], Vec::new(), 0, None)
            }
            Mode::Http => {
                let handle = proxy::start_session(
                    decrypt, self.cfg.decrypt_skip.clone(), shared.clone(), &self.cfg.ca_dir,
                )?;
                if let Err(e) = proxy::chain_add(&id, &mac, handle.port, decrypt) {
                    let _ = handle.stop.send(true);
                    return Err(e);
                }
                (Vec::new(), Vec::new(), handle.port, Some(handle.stop))
            }
        };

        self.seq += 1;
        self.sessions.push(Session {
            id: id.clone(), mac, mode, decrypt, port,
            ifaces, files, pids,
            started: now, seconds, max_bytes,
            bytes: 0, state: State::Running, stop_reason: String::new(),
            shared, proxy_stop,
        });
        self.dirty = true;
        self.save();
        Ok(self.sessions.last().expect("just pushed"))
    }

    /// tap 模式：加载引擎（懒）、插链首 attach、写开关、开 pcap 直写。失败只回滚本次 attach 的接口。
    fn start_tap(&mut self, id: &str, mac: &str, ifaces: &[String], path: &Path) -> Result<(), String> {
        if self.tap.is_none() {
            self.tap = Some(TapEngine::load(&self.cfg.tap_obj)?);
        }
        let mut attached: Vec<String> = Vec::new();
        for iface in ifaces {
            let result = self.tap.as_mut().expect("just initialized").attach_iface(iface);
            if let Err(e) = result {
                let engine = self.tap.as_mut().expect("just initialized");
                for name in attached.drain(..) {
                    engine.detach_iface(&name);
                }
                return Err(e);
            }
            attached.push(iface.clone());
        }
        let engine = self.tap.as_mut().expect("just initialized");
        let Some(bytes) = mac_bytes(mac) else { return Err("invalid_mac".into()) };
        if let Err(e) = engine.enable(bytes) {
            for name in attached.drain(..) {
                engine.detach_iface(&name);
            }
            return Err(e);
        }
        let mut writer = BufWriter::new(
            File::create(path).map_err(|e| format!("创建 {path:?}: {e}"))?,
        );
        writer.write_all(&parse::pcap_global_header(tap::CAP_FRAME_DATA))
            .map_err(|e| format!("写 pcap 头: {e}"))?;
        self.writers.insert(id.to_string(), writer);
        Ok(())
    }

    /// 按 id（或 running 会话的 MAC）停止。
    pub fn stop(&mut self, id_or_mac: &str) -> Result<&Session, String> {
        let needle = id_or_mac.trim().to_ascii_lowercase();
        let Some(index) = self.sessions.iter().position(|s|
            s.state == State::Running && (s.id == needle || s.mac == needle)) else {
            return Err("not_found".into());
        };
        let (id, mode, mac) = {
            let session = &self.sessions[index];
            (session.id.clone(), session.mode, session.mac.clone())
        };
        match mode {
            Mode::Tap => {
                if let (Some(engine), Some(bytes)) = (self.tap.as_mut(), mac_bytes(&mac)) {
                    engine.disable(bytes);
                }
                self.writers.remove(&id);
            }
            Mode::Http => {
                if let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) {
                    if let Some(stop) = session.proxy_stop.take() {
                        let _ = stop.send(true);
                    }
                }
                proxy::chain_del(&id);
            }
            Mode::Tcpdump => {
                self.term_session(&id);
                self.wait_reap(&id);
            }
        }
        self.finalize(&id, "stopped");
        self.detach_tap_if_idle();
        self.save();
        Ok(&self.sessions[index])
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        let Some(index) = self.sessions.iter().position(|s| s.id == id) else {
            return Err("not_found".into());
        };
        if self.sessions[index].state == State::Running {
            return Err("session_running".into());
        }
        let mut paths: Vec<PathBuf> = self.sessions[index].files.clone();
        paths.extend(self.sessions[index].files.iter().map(|f| f.with_extension("log")));
        for file in paths {
            let _ = fs::remove_file(file);
        }
        self.sessions.remove(index);
        self.save();
        Ok(())
    }

    fn term_session(&mut self, id: &str) {
        if let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) {
            for pid in session.pids.iter() { self.proc.term(*pid); }
        }
    }

    /// 有界等待收割；超时留给 tick 兜底（tcpdump 对 SIGTERM 的 flush 很快）。
    fn wait_reap(&mut self, id: &str) {
        for _ in 0..REAP_ROUNDS {
            let Some(session) = self.sessions.iter().find(|s| s.id == id) else { return };
            let all_gone = session.pids.iter().all(|pid|
                self.proc.reap(*pid).is_some() || !self.proc.alive(*pid));
            if all_gone { return; }
            std::thread::sleep(std::time::Duration::from_millis(REAP_SLEEP_MS));
        }
    }

    fn finalize(&mut self, id: &str, reason: &str) {
        let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) else { return };
        if session.state == State::Done { return; }
        session.state = State::Done;
        session.stop_reason = reason.to_owned();
        session.bytes = file_bytes(&session.files);
        self.dirty = true;
    }

    /// 最后一个 tap 会话结束后释放 TC 挂载（引擎与 map 保留复用）。
    fn detach_tap_if_idle(&mut self) {
        if self.sessions.iter().any(|s| s.mode == Mode::Tap && s.state == State::Running) {
            return;
        }
        if let Some(engine) = self.tap.as_mut() {
            engine.detach_all();
        }
    }

    /// 1s tick：排空 tap ringbuf → pcap/域名；执行各模式限额；清理过旧会话。
    pub fn tick(&mut self, now: u64) {
        let running: Vec<(String, Mode, String)> = self.sessions.iter()
            .filter(|s| s.state == State::Running)
            .map(|s| (s.id.clone(), s.mode, s.mac.clone()))
            .collect();
        let disk_short = disk_free(&self.cfg.dir).is_some_and(|free| free < DISK_FLOOR_BYTES);

        // tap：ringbuf → pcap 直写 + 域名画像（先于限额检查，保证最后一批帧落盘）
        if self.sessions.iter().any(|s| s.state == State::Running && s.mode == Mode::Tap) {
            let frames = self.tap.as_mut()
                .map(|engine| engine.drain(tap::monotonic_epoch_offset()))
                .unwrap_or_default();
            for frame in frames {
                let mac = frame.mac.to_str();
                let Some(session) = self.sessions.iter().find(|s|
                    s.state == State::Running && s.mode == Mode::Tap && s.mac == mac) else {
                    continue;
                };
                if let Some(writer) = self.writers.get_mut(&session.id) {
                    let secs = frame.epoch_ns / 1_000_000_000;
                    let usecs = (frame.epoch_ns % 1_000_000_000 / 1000) as u32;
                    let _ = writer.write_all(&parse::pcap_record(secs, usecs, frame.orig_len, &frame.data));
                }
                if let Some(domain) = parse::dns_query_name(&frame.data)
                    .or_else(|| parse::tls_sni(&frame.data))
                {
                    session.shared.add_domain(domain, frame.epoch_ns / 1_000_000_000);
                }
                let session_id = session.id.clone();
                if let Some(session) = self.sessions.iter_mut().find(|s| s.id == session_id) {
                    session.bytes += frame.orig_len as u64;
                }
            }
            for writer in self.writers.values_mut() {
                let _ = writer.flush();
            }
        }

        for (id, mode, mac) in running {
            let Some(session) = self.sessions.iter().find(|s| s.id == id) else { continue };
            let pending = if disk_short { Some("disk") }
                else if now >= session.started.saturating_add(session.seconds) { Some("time") }
                else if mode != Mode::Http && file_bytes(&session.files) >= session.max_bytes { Some("size") }
                else { None };
            match mode {
                Mode::Tcpdump => {
                    let exits: Vec<Option<i32>> = session.pids.iter().map(|pid| {
                        self.proc.reap(*pid).or_else(|| (!self.proc.alive(*pid)).then_some(-1))
                    }).collect();
                    if exits.iter().all(Option::is_some) {
                        let reason = pending.unwrap_or_else(|| {
                            if exits.iter().all(|code| *code == Some(0)) { "completed" } else { "failed" }
                        });
                        self.finalize(&id, reason);
                    } else if let Some(reason) = pending {
                        if let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) {
                            session.stop_reason = reason.to_owned();
                        }
                        self.term_session(&id);
                    }
                }
                Mode::Tap => {
                    if let Some(reason) = pending {
                        if let (Some(engine), Some(bytes)) = (self.tap.as_mut(), mac_bytes(&mac)) {
                            engine.disable(bytes);
                        }
                        self.writers.remove(&id);
                        self.finalize(&id, reason);
                    }
                }
                Mode::Http => {
                    if let Some(reason) = pending {
                        if let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) {
                            if let Some(stop) = session.proxy_stop.take() {
                                let _ = stop.send(true);
                            }
                        }
                        proxy::chain_del(&id);
                        self.finalize(&id, reason);
                    }
                }
            }
        }
        self.detach_tap_if_idle();
        self.prune();
        if self.dirty { self.save(); }
    }

    fn prune(&mut self) {
        let done: Vec<String> = self.sessions.iter().filter(|s| s.state == State::Done)
            .map(|s| s.id.clone()).collect();
        let excess = done.len().saturating_sub(self.cfg.keep as usize);
        for id in done.into_iter().take(excess) {
            let _ = self.delete(&id);
        }
    }

    pub fn sessions(&self) -> &[Session] { &self.sessions }

    pub fn running_count(&self) -> usize {
        self.sessions.iter().filter(|s| s.state == State::Running).count()
    }

    pub fn domains(&self, id: &str) -> Option<Vec<(String, DomainStat)>> {
        self.sessions.iter().find(|s| s.id == id).map(|s| s.shared.top_domains(DOMAIN_TOP))
    }

    pub fn events(&self, id: &str) -> Option<Vec<Event>> {
        self.sessions.iter().find(|s| s.id == id).map(|s| s.shared.snapshot_events())
    }

    pub fn har(&self, id: &str) -> Option<serde_json::Value> {
        let events = self.events(id)?;
        Some(proxy::har_json(&events, env!("CARGO_PKG_VERSION")))
    }

    fn save(&mut self) {
        self.dirty = false;
        let Ok(data) = serde_json::to_vec(&self.sessions) else {
            eprintln!("[zen-capture] sessions.json 序列化失败");
            return;
        };
        let path = self.store_path();
        let temp = path.with_extension("json.tmp");
        if fs::write(&temp, data).and_then(|_| fs::rename(&temp, &path)).is_err() {
            eprintln!("[zen-capture] sessions.json 写入失败");
        }
    }

    /// SIGTERM：按模式停止全部 running 会话并落盘。
    pub fn shutdown(&mut self) {
        let running: Vec<(String, Mode, String)> = self.sessions.iter()
            .filter(|s| s.state == State::Running)
            .map(|s| (s.id.clone(), s.mode, s.mac.clone()))
            .collect();
        for (id, mode, mac) in running {
            match mode {
                Mode::Tcpdump => {
                    self.term_session(&id);
                    self.wait_reap(&id);
                }
                Mode::Http => {
                    if let Some(session) = self.sessions.iter_mut().find(|s| s.id == id) {
                        if let Some(stop) = session.proxy_stop.take() {
                            let _ = stop.send(true);
                        }
                    }
                    proxy::chain_del(&id);
                }
                Mode::Tap => {
                    if let (Some(engine), Some(bytes)) = (self.tap.as_mut(), mac_bytes(&mac)) {
                        engine.disable(bytes);
                    }
                    self.writers.remove(&id);
                }
            }
            self.finalize(&id, "interrupted");
        }
        if let Some(engine) = self.tap.as_mut() {
            engine.detach_all();
        }
        self.save();
    }
}

#[cfg(target_os = "linux")]
fn disk_free(dir: &Path) -> Option<u64> {
    let Ok(cpath) = std::ffi::CString::new(dir.to_string_lossy().into_owned()) else { return None };
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statvfs(cpath.as_ptr(), &mut stat) } == 0)
        .then(|| stat.f_bavail as u64 * stat.f_bsize as u64)
}

#[cfg(not(target_os = "linux"))]
fn disk_free(_dir: &Path) -> Option<u64> { None }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[derive(Default)]
    struct ProcState {
        alive: bool,
        exit: Option<i32>,
    }

    struct FakeInner {
        spawned: Mutex<Vec<Vec<String>>>,
        terminated: Mutex<Vec<u32>>,
        procs: Mutex<BTreeMap<u32, ProcState>>,
        next_pid: AtomicU32,
    }

    /// 假进程管理器：返回句柄以便测试操纵存活/退出状态并断言调用。
    struct FakeProc { inner: Arc<FakeInner> }

    #[derive(Clone)]
    struct FakeHandle { inner: Arc<FakeInner> }

    impl FakeProc {
        fn new() -> (FakeProc, FakeHandle) {
            let inner = Arc::new(FakeInner {
                spawned: Mutex::new(Vec::new()), terminated: Mutex::new(Vec::new()),
                procs: Mutex::new(BTreeMap::new()), next_pid: AtomicU32::new(100),
            });
            (FakeProc { inner: inner.clone() }, FakeHandle { inner })
        }
    }

    impl FakeHandle {
        fn keep_alive(&self, pid: u32) { self.inner.procs.lock().unwrap().entry(pid).or_default().alive = true; }
        fn exit(&self, pid: u32, code: i32) {
            let mut procs = self.inner.procs.lock().unwrap();
            let state = procs.entry(pid).or_default();
            state.alive = false;
            state.exit = Some(code);
        }
        fn terminated(&self) -> Vec<u32> { self.inner.terminated.lock().unwrap().clone() }
        fn spawned(&self) -> Vec<Vec<String>> { self.inner.spawned.lock().unwrap().clone() }
    }

    impl Proc for FakeProc {
        fn spawn(&self, args: &[String], _log: &Path) -> io::Result<u32> {
            let pid = self.inner.next_pid.fetch_add(1, Ordering::SeqCst);
            self.inner.spawned.lock().unwrap().push(args.to_vec());
            self.inner.procs.lock().unwrap().entry(pid).or_default();
            Ok(pid)
        }
        fn alive(&self, pid: u32) -> bool {
            self.inner.procs.lock().unwrap().get(&pid).is_some_and(|s| s.alive)
        }
        fn term(&self, pid: u32) { self.inner.terminated.lock().unwrap().push(pid); }
        fn reap(&self, pid: u32) -> Option<i32> {
            self.inner.procs.lock().unwrap().get(&pid).and_then(|s| s.exit)
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zen-capture-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn config(dir: &Path) -> Config {
        Config {
            dir: dir.to_path_buf(),
            ifaces: vec!["br-lan".into()],
            max_sessions: 2, max_duration: 600, max_file_mb: 8, snaplen: 128, keep: 2,
            tap_obj: PathBuf::from("/usr/share/zen-traffic/zen_capture.bpf.o"),
            ca_dir: dir.join("ca"),
            decrypt_skip: Vec::new(),
        }
    }

    fn request(mac: &str) -> StartRequest {
        StartRequest { mac: mac.into(), mode: Some(Mode::Tcpdump), seconds: None, max_bytes: None, snap: None, decrypt: None }
    }

    fn started(dir: &Path) -> (Manager, FakeHandle) {
        let (proc, handle) = FakeProc::new();
        (Manager::with_proc(config(dir), Box::new(proc)).unwrap(), handle)
    }

    const FINDER: fn() -> Option<String> = || Some("/usr/sbin/tcpdump".into());

    #[test]
    fn mac_validation_accepts_unicast_and_rejects_the_rest() {
        for mac in ["aa:bb:cc:dd:ee:ff", "AA:BB:CC:DD:EE:F0", "00:11:22:33:44:55"] {
            assert!(valid_mac(mac), "{mac}");
        }
        for mac in ["ff:ff:ff:ff:ff:ff", "01:00:5e:00:00:01", "00:00:00:00:00:00",
            "aa:bb:cc:dd:ee", "aa:bb:cc:dd:ee:fg", "aa-bb-cc-dd-ee-ff", ""] {
            assert!(!valid_mac(mac), "{mac}");
        }
        assert_eq!(mac_bytes("aa:bb:cc:dd:ee:ff"), Some([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]));
        assert_eq!(mac_bytes("zz:bb:cc:dd:ee:ff"), None);
    }

    #[test]
    fn tcpdump_args_carry_interface_snaplen_and_mac_filter() {
        let args = tcpdump_args("/usr/sbin/tcpdump", "eth0", 128, Path::new("/tmp/x-eth0.pcap"), "aa:bb:cc:dd:ee:ff");
        assert_eq!(args[0], "/usr/sbin/tcpdump");
        assert_eq!(&args[1..6], ["-i", "eth0", "-s", "128", "-U"]);
        assert_eq!(&args[6..8], ["-w", "/tmp/x-eth0.pcap"]);
        assert_eq!(&args[8..], ["ether", "host", "aa:bb:cc:dd:ee:ff"]);
    }

    #[test]
    fn limits_are_clamped_to_configured_caps() {
        assert_eq!(clamp_seconds(None, 600), 600);
        assert_eq!(clamp_seconds(Some(5), 600), SECONDS_MIN);
        assert_eq!(clamp_seconds(Some(3600), 600), 600);
        assert_eq!(clamp_bytes(Some(1), 8), BYTES_MIN);
        assert_eq!(clamp_bytes(None, 8), 8 * 1024 * 1024);
        assert_eq!(clamp_bytes(Some(1024 * 1024 * 1024), 8), 8 * 1024 * 1024);
        assert_eq!(clamp_snap(None, 128), 128);
        assert_eq!(clamp_snap(Some(4), 128), SNAP_MIN);
        assert_eq!(clamp_snap(Some(u32::MAX), 128), SNAP_MAX);
    }

    #[test]
    fn bridge_expansion_matches_trafficd_topology() {
        let resolved = expand_with(
            &["br-lan".into(), "eth0".into(), "br-guest".into()],
            &|name| Ok(match name {
                "br-lan" => Some(vec!["eth0".into(), "wlan0".into()]),
                "br-guest" => Some(vec!["eth0.20".into()]),
                _ => None,
            })).unwrap();
        assert_eq!(resolved, ["eth0", "eth0.20", "wlan0"]);
        assert_eq!(expand_with(&["br-lan".into()], &|_| Ok(Some(vec![]))).unwrap(), ["br-lan"]);
        assert_eq!(expand_with(&["br-lan".into()], &|n| Ok((n == "br-lan").then(|| vec!["eth0".into()]))).unwrap(), ["eth0"]);
        assert!(expand_with(&["x".into()], &|_| Err("snapshot failed".into())).is_err());
        assert!(expand_with(&["br".into()], &|_| Ok(Some(vec!["br".into()]))).is_err());
    }

    #[test]
    fn start_validates_mac_tcpdump_and_session_caps() {
        let dir = temp_dir("caps");
        let (mut manager, handle) = started(&dir);

        assert_eq!(manager.start_with(&request("zz:zz"), 1000, FINDER).unwrap_err(), "invalid_mac");
        assert_eq!(manager.start_with(&request("aa:bb:cc:dd:ee:01"), 1000, || None).unwrap_err(), "tcpdump_missing");

        let session = manager.start_with(&request("aa:bb:cc:dd:ee:01"), 1000, FINDER).unwrap();
        assert_eq!(session.state, State::Running);
        assert_eq!(session.mode, Mode::Tcpdump);
        assert_eq!(session.mac, "aa:bb:cc:dd:ee:01");
        assert_eq!(session.ifaces, ["br-lan"]);
        assert_eq!(session.seconds, 600, "默认时长 = 配置上限");
        assert_eq!(session.max_bytes, 8 * 1024 * 1024);
        let spawned = handle.spawned();
        assert_eq!(spawned.len(), 1);
        assert!(spawned[0][6..].windows(2).any(|w| w == ["ether", "host"]));

        assert_eq!(manager.start_with(&request("aa:bb:cc:dd:ee:01"), 1000, FINDER).unwrap_err(), "already_capturing");
        manager.cfg.max_sessions = 1;
        assert_eq!(manager.start_with(&request("aa:bb:cc:dd:ee:02"), 1000, FINDER).unwrap_err(), "too_many_sessions");
        assert_eq!(manager.sessions().len(), 1);
        assert_eq!(manager.running_count(), 1);
    }

    #[test]
    fn shared_data_is_capped_and_sorted() {
        let shared = SessionShared::new();
        for index in 0..600u64 {
            shared.push_event(Event {
                ts: index, kind: "http".into(), method: "GET".into(),
                host: "h".into(), path: "/".into(), status: 200,
                req_bytes: 1, resp_bytes: 2,
            });
            shared.add_domain(format!("d{index}.example"), index);
        }
        assert_eq!(shared.snapshot_events().len(), 500);
        assert_eq!(shared.snapshot_events()[0].ts, 100, "最旧事件被淘汰");
        let top = shared.top_domains(10);
        assert_eq!(top.len(), 10);
        assert_eq!(top[0].1.count, 1);
        assert_eq!(top[0].0, "d599.example", "计数相同按最近活跃排序");
    }

    #[test]
    fn full_lifecycle_start_stop_and_delete() {
        let dir = temp_dir("lifecycle");
        let (mut manager, handle) = started(&dir);

        let session = manager.start_with(&request("aa:bb:cc:dd:ee:01"), 1000, FINDER).unwrap().id.clone();
        let files = manager.sessions()[0].files.clone();
        assert!(manager.delete(&session).is_err_and(|e| e == "session_running"));

        handle.exit(manager.sessions()[0].pids[0], 0); // tcpdump 已被 SIGTERM 收割
        manager.stop(&session).unwrap();
        let done = &manager.sessions()[0];
        assert_eq!(done.state, State::Done);
        assert_eq!(done.stop_reason, "stopped");

        assert!(manager.stop(&session).is_err_and(|e| e == "not_found"));
        manager.delete(&session).unwrap();
        assert!(manager.sessions().is_empty());
        assert!(!files[0].exists(), "删除会话必须移除 pcap");
    }

    #[test]
    fn stop_by_mac_and_finalize_bytes_from_files() {
        let dir = temp_dir("bymac");
        let (mut manager, handle) = started(&dir);
        manager.start_with(&request("aa:bb:cc:dd:ee:01"), 1000, FINDER).unwrap();
        fs::write(&manager.sessions()[0].files[0], [0u8; 96]).unwrap();
        let pid = manager.sessions()[0].pids[0];
        handle.keep_alive(pid);

        manager.stop("aa:bb:cc:dd:ee:01").unwrap(); // 按 MAC 命中
        assert!(handle.terminated().contains(&pid), "stop 必须先 SIGTERM tcpdump");
        let done = &manager.sessions()[0];
        assert_eq!(done.state, State::Done);
        assert_eq!(done.bytes, 96);
    }

    #[test]
    fn tick_enforces_deadline_size_and_disk() {
        let dir = temp_dir("tick");
        let (mut manager, handle) = started(&dir);

        // 超时：进程已退出 → pending("time") finalize
        manager.start_with(&request("aa:bb:cc:dd:ee:01"), 0, FINDER).unwrap();
        manager.sessions.last_mut().unwrap().seconds = 60;
        manager.tick(100_000);
        let done = manager.sessions().last().unwrap();
        assert_eq!(done.state, State::Done);
        assert_eq!(done.stop_reason, "time");

        // 大小超限：文件先超限、进程仍存活 → term，收割后以 size finalize
        manager.cfg.max_sessions = 3;
        manager.start_with(&request("aa:bb:cc:dd:ee:02"), 100_000, FINDER).unwrap();
        let pid = manager.sessions().last().unwrap().pids[0];
        handle.keep_alive(pid);
        let file = manager.sessions().last().unwrap().files[0].clone();
        fs::write(&file, vec![0u8; 9 * 1024 * 1024]).unwrap();
        manager.tick(100_005);
        assert_eq!(handle.terminated(), vec![pid], "超限会话必须被 SIGTERM");
        handle.exit(pid, 0);
        manager.tick(100_006);
        let done = manager.sessions().last().unwrap();
        assert_eq!(done.state, State::Done);
        assert_eq!(done.stop_reason, "size");
        assert_eq!(done.bytes, 9 * 1024 * 1024);

        // 正常完成：进程自己退出（exit 0）且未触限额 → completed
        manager.start_with(&request("aa:bb:cc:dd:ee:03"), 100_000, FINDER).unwrap();
        let third = manager.sessions().last().unwrap().id.clone();
        let pid = manager.sessions().last().unwrap().pids[0];
        handle.exit(pid, 0);
        manager.tick(100_010);
        let done = manager.sessions().last().unwrap();
        assert_eq!(done.id, third);
        assert_eq!(done.stop_reason, "completed");

        // tcpdump 异常退出 → failed
        manager.cfg.max_sessions = 4;
        manager.start_with(&request("aa:bb:cc:dd:ee:04"), 100_000, FINDER).unwrap();
        let pid = manager.sessions().last().unwrap().pids[0];
        handle.exit(pid, 1);
        manager.tick(100_020);
        assert_eq!(manager.sessions().last().unwrap().stop_reason, "failed");
    }

    #[test]
    fn http_sessions_are_finalized_by_deadline_not_by_empty_pids() {
        let dir = temp_dir("httpdeadline");
        let (mut manager, _handle) = started(&dir);
        // 不走真实 nft/代理：手工注入 http 会话（进程隔离由真机验收覆盖）
        manager.sessions.push(Session {
            id: "0f0f-0001".into(), mac: "aa:bb:cc:dd:ee:09".into(), mode: Mode::Http,
            decrypt: false, port: 18765, ifaces: vec!["br-lan".into()], files: vec![], pids: vec![],
            started: 0, seconds: 60, max_bytes: 8 * 1024 * 1024, bytes: 0,
            state: State::Running, stop_reason: String::new(),
            shared: SessionShared::new(), proxy_stop: None,
        });
        manager.cfg.max_sessions = 4;
        manager.tick(100_000);
        let done = manager.sessions().last().unwrap();
        assert_eq!(done.state, State::Done, "http 会话不得因 pids 为空被误判 completed");
        assert_eq!(done.stop_reason, "time");

        // http 会话的域名/事件经共享结构可查
        manager.sessions.last_mut().unwrap().shared.add_domain("a.example".into(), 5);
        let domains = manager.domains("0f0f-0001").unwrap();
        assert_eq!(domains, vec![("a.example".to_string(), DomainStat { count: 1, last_ts: 5 })]);
        assert!(manager.events("0f0f-0001").unwrap().is_empty());
        assert!(manager.har("0f0f-0001").is_some());
        assert!(manager.domains("missing").is_none());
    }

    #[test]
    fn store_survives_restart_and_marks_interrupted() {
        let dir = temp_dir("restart");
        let (mut first, handle) = started(&dir);
        first.start_with(&request("aa:bb:cc:dd:ee:01"), 1000, FINDER).unwrap();
        let pid = first.sessions()[0].pids[0];
        handle.keep_alive(pid);
        let file = first.sessions()[0].files[0].clone();
        fs::write(&file, [0u8; 48]).unwrap();
        // 模拟 daemon 崩溃：不执行 shutdown，直接以同一目录重新 init。

        let (second, second_handle) = started(&dir);
        let recovered = &second.sessions()[0];
        assert_eq!(recovered.state, State::Done);
        assert_eq!(recovered.stop_reason, "interrupted");
        assert_eq!(recovered.bytes, 48);
        assert!(second_handle.terminated().contains(&pid), "孤儿 tcpdump 必须被收割");
    }

    #[test]
    fn orphan_pcap_files_are_swept_on_init() {
        let dir = temp_dir("orphans");
        {
            let (mut manager, _handle) = started(&dir);
            manager.start_with(&request("aa:bb:cc:dd:ee:01"), 1000, FINDER).unwrap();
            let id = manager.sessions()[0].id.clone();
            manager.stop(&id).unwrap();
        }
        let stray = dir.join("stray-eth0.pcap");
        let stray_log = dir.join("stray-eth0.log");
        fs::write(&stray, [0u8; 8]).unwrap();
        fs::write(&stray_log, [0u8; 8]).unwrap();

        let (reopened, _) = started(&dir);
        assert_eq!(reopened.sessions().len(), 1, "有记录的会话必须保留");
        assert!(!stray.exists() && !stray_log.exists(), "孤儿文件必须被清理");
    }

    #[test]
    fn prune_keeps_the_newest_completed_sessions() {
        let dir = temp_dir("prune");
        let (mut manager, _) = started(&dir);
        for index in 0..4u32 {
            manager.sessions.push(Session {
                id: format!("00000064-{index:04x}"), mac: format!("aa:bb:cc:dd:ee:0{index}"),
                mode: Mode::Tcpdump, decrypt: false, port: 0,
                ifaces: vec!["eth0".into()], files: vec![], pids: vec![],
                started: 1000 + index as u64, seconds: 60, max_bytes: 1024, bytes: 0,
                state: State::Done, stop_reason: "completed".into(),
                shared: SessionShared::new(), proxy_stop: None,
            });
        }
        manager.cfg.keep = 2;
        manager.tick(2000);
        let ids: Vec<String> = manager.sessions().iter().map(|s| s.id.clone()).collect();
        assert_eq!(ids, ["00000064-0002", "00000064-0003"]);
    }

    #[test]
    fn multi_interface_session_spawns_one_tcpdump_per_port() {
        let dir = temp_dir("multi");
        let (mut manager, handle) = started(&dir);
        manager.cfg.ifaces = vec!["br-lan".into()];
        let session = manager.start_with(&request("aa:bb:cc:dd:ee:01"), 1000, FINDER).unwrap();
        assert_eq!(session.ifaces.len(), 1, "测试环境无 /sys/class/net，回落到配置名本身");
        assert_eq!(handle.spawned().len(), session.ifaces.len());
    }
}
