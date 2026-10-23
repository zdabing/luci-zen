//! parse.rs — ringbuf 帧的用户态解析（DNS qname / TLS SNI / HTTP 头）与 pcap 记录格式。
//!
//! BPF 侧只负责按 MAC 过滤并搬帧；全部协议解析在用户态完成，纯函数可单测。
//! 解析尽力而为：超出 snaplen（256B）的 ClientHello SNI 不可见，解析失败静默跳过。

use std::net::Ipv4Addr;

pub const PCAP_MAGIC: u32 = 0xa1b2_c3d4; // 小端微秒
pub const LINKTYPE_ETHERNET: u32 = 1;

/// pcap 全局头（24 字节，小端）
pub fn pcap_global_header(snaplen: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(24);
    out.extend_from_slice(&PCAP_MAGIC.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes()); // version major
    out.extend_from_slice(&4u16.to_le_bytes()); // version minor
    out.extend_from_slice(&0i32.to_le_bytes()); // thiszone
    out.extend_from_slice(&0u32.to_le_bytes()); // sigfigs
    out.extend_from_slice(&snaplen.to_le_bytes());
    out.extend_from_slice(&LINKTYPE_ETHERNET.to_le_bytes());
    out
}

/// pcap 单包记录头（16 字节，小端）+ 原始帧
pub fn pcap_record(epoch_secs: u64, epoch_usecs: u32, orig_len: u32, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + data.len());
    out.extend_from_slice(&(epoch_secs as u32).to_le_bytes());
    out.extend_from_slice(&epoch_usecs.to_le_bytes());
    out.extend_from_slice(&data.len() as u32.to_le_bytes());
    out.extend_from_slice(&orig_len.to_le_bytes());
    out.extend_from_slice(data);
    out
}

/// L2 帧的 L3 头起点（跳过 VLAN/QinQ），None = 非 IP 或帧过短
pub fn ip_start(frame: &[u8]) -> Option<usize> {
    if frame.len() < 14 {
        return None;
    }
    let mut proto = u16::from_be_bytes([frame[12], frame[13]]);
    let mut off = 14;
    if proto == 0x8100 || proto == 0x88A8 {
        if frame.len() < off + 4 {
            return None;
        }
        proto = u16::from_be_bytes([frame[off + 2], frame[off + 3]]);
        off += 4;
    }
    match proto {
        0x0800 if frame.len() >= off + 20 && frame[off] >> 4 == 4 => Some(off),
        0x86DD if frame.len() >= off + 40 && frame[off] >> 4 == 6 => Some(off),
        _ => None,
    }
}

/// 传输层：返回 (proto, 传输头起点)。IPv6 只识别无扩展头的帧。
pub fn transport(frame: &[u8]) -> Option<(u8, usize)> {
    let l3 = ip_start(frame)?;
    if frame[l3] >> 4 == 4 {
        let ihl = usize::from(frame[l3] & 0x0f) * 4;
        if ihl < 20 || frame.len() < l3 + ihl {
            return None;
        }
        // 分片偏移非 0 的包没有传输头
        let frag = u16::from_be_bytes([frame[l3 + 6], frame[l3 + 7]]);
        if frag & 0x1fff != 0 {
            return None;
        }
        match frame[l3 + 9] {
            6 => Some((6, l3 + ihl)),
            17 => Some((17, l3 + ihl)),
            _ => None,
        }
    } else if frame.len() >= l3 + 44 {
        match frame[l3 + 6] {
            6 => Some((6, l3 + 40)),
            17 => Some((17, l3 + 40)),
            _ => None,
        }
    } else {
        None
    }
}

fn udp_ports(frame: &[u8], l4: usize) -> Option<(u16, u16)> {
    if frame.len() < l4 + 8 {
        return None;
    }
    let sport = u16::from_be_bytes([frame[l4], frame[l4 + 1]]);
    let dport = u16::from_be_bytes([frame[l4 + 2], frame[l4 + 3]]);
    Some((sport, dport))
}

fn tcp_payload(frame: &[u8], l4: usize) -> Option<&[u8]> {
    if frame.len() < l4 + 20 {
        return None;
    }
    let data_off = usize::from(frame[l4 + 12] >> 4) * 4;
    if data_off < 20 || frame.len() < l4 + data_off {
        return None;
    }
    Some(&frame[l4 + data_off..])
}

/// DNS 查询域名（仅查询报文 qr=0；响应与失败返回 None）
pub fn dns_query_name(frame: &[u8]) -> Option<String> {
    let (proto, l4) = transport(frame)?;
    if proto != 17 {
        return None;
    }
    let (sport, dport) = udp_ports(frame, l4)?;
    if dport != 53 {
        return None;
    }
    let _ = sport;
    let payload = frame.get(l4 + 8..)?;
    if payload.len() < 12 {
        return None;
    }
    let flags = u16::from_be_bytes([payload[2], payload[3]]);
    if flags & 0x8000 != 0 {
        return None; // 响应
    }
    let questions = u16::from_be_bytes([payload[4], payload[5]]);
    if questions == 0 {
        return None;
    }
    // 走 qname 标签：≤8 段、总长 ≤255，终止于 0 长度标签
    let mut name = String::new();
    let mut off = 12;
    let mut labels = 0;
    loop {
        if off >= payload.len() || labels >= 8 {
            return None;
        }
        let len = payload[off] as usize;
        off += 1;
        if len == 0 {
            break;
        }
        if len > 63 || off + len > payload.len() {
            return None;
        }
        let label = std::str::from_utf8(&payload[off..off + len]).ok()?;
        name.push_str(&label.to_ascii_lowercase());
        name.push('.');
        off += len;
        labels += 1;
    }
    if name.is_empty() || name.len() > 255 {
        return None;
    }
    Some(name)
}

/// 首个 TLS 记录的总字节数（5 字节头 + record length）；头不完整时 None
pub fn tls_record_len(payload: &[u8]) -> Option<usize> {
    if payload.len() < 5 {
        return None;
    }
    Some(5 + usize::from(u16::from_be_bytes([payload[3], payload[4]])))
}

/// TLS ClientHello 的 SNI（tap 帧入口：先剥 L2/L3/L4）
pub fn tls_sni(frame: &[u8]) -> Option<String> {
    let (proto, l4) = transport(frame)?;
    if proto != 6 {
        return None;
    }
    let payload = tcp_payload(frame, l4)?;
    sni_from_record(payload)
}

/// 裸 TLS 记录（MITM 首包入口）中的 ClientHello SNI
pub fn sni_from_record(payload: &[u8]) -> Option<String> {
    // record: type 0x16 handshake, version major 0x03
    if payload.len() < 6 || payload[0] != 0x16 || payload[1] != 0x03 {
        return None;
    }
    if payload[5] != 0x01 {
        return None; // 非 ClientHello
    }
    let hs = &payload[5..];
    if hs.len() < 39 {
        return None;
    }
    // handshake header(4) + client_version(2) + random(32) = 38 → session_id_len at hs[38]
    let mut off = 39;
    let sid_len = usize::from(hs[38]);
    off += sid_len;
    if hs.len() < off + 4 {
        return None;
    }
    let cipher_len = usize::from(u16::from_be_bytes([hs[off], hs[off + 1]]));
    off += cipher_len + 1; // + compression methods (1 字节长度)
    if hs.len() < off + 2 {
        return None;
    }
    let ext_total = usize::from(u16::from_be_bytes([hs[off], hs[off + 1]]));
    off += 2;
    let _ = ext_total; // 扩展区总长仅用于边界提示，逐项长度各自校验
    while off + 4 <= hs.len() {
        let ext_type = u16::from_be_bytes([hs[off], hs[off + 1]]);
        let ext_len = usize::from(u16::from_be_bytes([hs[off + 2], hs[off + 3]]));
        let body = off + 4;
        if body + ext_len > hs.len() {
            return None;
        }
        if ext_type == 0x0000 && ext_len >= 5 {
            // server_name_list: list_len(2) + name_type(1)=0 + name_len(2) + name
            let name_len = usize::from(u16::from_be_bytes([hs[body + 3], hs[body + 4]]));
            if hs[body + 2] == 0 && name_len > 0 && body + 5 + name_len <= body + ext_len {
                let name = std::str::from_utf8(&hs[body + 5..body + 5 + name_len]).ok()?;
                let name = name.to_ascii_lowercase();
                if !name.is_empty() && name.len() <= 253 {
                    return Some(name);
                }
            }
            return None;
        }
        off = body + ext_len;
    }
    None
}

/// 请求/响应头解析结果（head 含结束 CRLFCRLF 的字节数）
#[derive(Clone)]
pub struct HttpHead {
    pub head_len: usize,
    pub method: String,
    pub host: String,
    pub path: String,
    pub status: u16,
    pub close: bool,
    pub content_length: Option<u64>,
    pub chunked: bool,
}

/// 解析 HTTP 请求头（透明代理收到的 origin-form）
pub fn parse_request_head(buf: &[u8]) -> Option<HttpHead> {
    let end = find_head_end(buf)?;
    let head = std::str::from_utf8(&buf[..end]).ok()?;
    let mut lines = head.split("\r\n");
    let request = lines.next()?;
    let mut parts = request.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let version = parts.next().unwrap_or("HTTP/1.1");
    if method.is_empty() || target.is_empty() || !version.starts_with("HTTP/") {
        return None;
    }
    let mut host = String::new();
    let mut close = version == "HTTP/1.0";
    let mut length = HeaderLengths::default();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            match name.as_str() {
                "host" if host.is_empty() => {
                    host = value.split('@').next_back().unwrap_or(value).to_ascii_lowercase();
                    if let Some((h, port)) = host.split_once(':') {
                        if port == "80" {
                            host = h.to_string();
                        }
                    }
                }
                "connection" if value.eq_ignore_ascii_case("close") => close = true,
                "content-length" => length.content = value.parse().ok(),
                "transfer-encoding" if value.to_ascii_lowercase().contains("chunked") => {
                    length.chunked = true;
                }
                _ => {}
            }
        }
    }
    if host.is_empty() {
        return None;
    }
    let (path, _) = target.split_once('?').unwrap_or((&target, ""));
    Some(HttpHead {
        head_len: end + 4,
        method,
        host,
        path: if path.is_empty() { "/".into() } else { path.to_string() },
        status: 0,
        close,
        content_length: length.content,
        chunked: length.chunked,
    })
}

/// 解析 HTTP 响应头（取状态码与 keep-alive 语义）
pub fn parse_response_head(buf: &[u8]) -> Option<HttpHead> {
    let end = find_head_end(buf)?;
    let head = std::str::from_utf8(&buf[..end]).ok()?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next()?;
    let status = status_line.split_whitespace().nth(1)?.parse().ok()?;
    let mut close = false;
    let mut length = HeaderLengths::default();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            match name.as_str() {
                "connection" if value.eq_ignore_ascii_case("close") => close = true,
                "content-length" => length.content = value.parse().ok(),
                "transfer-encoding" if value.to_ascii_lowercase().contains("chunked") => {
                    length.chunked = true;
                }
                _ => {}
            }
        }
    }
    Some(HttpHead {
        head_len: end + 4,
        method: String::new(),
        host: String::new(),
        path: String::new(),
        status,
        close,
        content_length: length.content,
        chunked: length.chunked,
    })
}

#[derive(Default)]
struct HeaderLengths {
    content: Option<u64>,
    chunked: bool,
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// 域名是否命中跳过名单（精确、前导点后缀或通配父域）
pub fn domain_skipped(domain: &str, skip: &[String]) -> bool {
    let domain = domain.trim_end_matches('.');
    skip.iter().any(|entry| {
        let entry = entry.trim_end_matches('.').to_ascii_lowercase();
        !entry.is_empty() && (domain == entry || domain.ends_with(&format!(".{entry}")))
    })
}

/// epoch 秒 → RFC3339（UTC，"2026-10-23T12:34:56Z"），HAR 用。
/// 天数→日期用 Howard Hinnant 的 civil_from_days 算法。
pub fn rfc3339(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86400) as i64;
    let secs_of_day = epoch_secs % 86400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60
    )
}

/// 用于测试的帧构造器
#[cfg(test)]
pub mod test_frames {
    pub fn eth_ip_udp53(payload: &[u8]) -> Vec<u8> {
        let mut frame = vec![0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x08, 0x00];
        frame.push(0x45);frame.push(0);frame.extend_from_slice(&(20 + 8 + payload.len() as u16).to_be_bytes());
        frame.extend_from_slice(&[0, 1, 0, 0, 64, 17, 0, 0]);
        frame.extend_from_slice(&Ipv4Addr::new(192, 168, 1, 2).octets());
        frame.extend_from_slice(&Ipv4Addr::new(1, 1, 1, 1).octets());
        // UDP：sport 59770 → dport 53，length，checksum 0
        frame.extend_from_slice(&[0xe9, 0x7a, 0x00, 0x35]);
        frame.extend_from_slice(&(8 + payload.len() as u16).to_be_bytes());
        frame.extend_from_slice(&[0, 0, 0, 0]);
        frame.extend_from_slice(payload);
        frame
    }

    pub fn dns_query(qname: &str) -> Vec<u8> {
        let mut msg = vec![0xab, 0xcd, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in qname.split('.').filter(|s| !s.is_empty()) {
            msg.push(label.len() as u8);
            msg.extend_from_slice(label.as_bytes());
        }
        msg.push(0);
        msg.extend_from_slice(&[0, 1, 0, 1]);
        msg
    }

    pub fn eth_ip_tcp443(payload: &[u8]) -> Vec<u8> {
        let mut frame = vec![0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x08, 0x00];
        frame.push(0x45);frame.push(0);frame.extend_from_slice(&(20 + 20 + payload.len() as u16).to_be_bytes());
        frame.extend_from_slice(&[0, 1, 0, 0, 64, 6, 0, 0]);
        frame.extend_from_slice(&Ipv4Addr::new(192, 168, 1, 2).octets());
        frame.extend_from_slice(&Ipv4Addr::new(1, 1, 1, 1).octets());
        // TCP：sport 59771 → dport 443，seq，ack，data offset 5，flags 0
        frame.extend_from_slice(&[
            0xe9, 0x7b, 0x01, 0xbb, 0, 0, 0, 1, 0, 0, 0, 2, 0x50, 0x10, 0xff, 0xff, 0, 0, 0, 0,
        ]);
        frame.extend_from_slice(payload);
        frame
    }

    pub fn client_hello(sni: &str) -> Vec<u8> {
        let mut ext = vec![0x00, 0x00]; // type server_name
        let mut list = vec![0x00]; // name_type host
        list.extend_from_slice(&(sni.len() as u16).to_be_bytes());
        list.extend_from_slice(sni.as_bytes());
        ext.extend_from_slice(&(list.len() as u16).to_be_bytes());
        ext.extend_from_slice(&list);

        let mut hs = vec![0x01];
        let mut body = vec![0x03, 0x03];
        body.extend_from_slice(&[0u8; 32]);
        body.push(0); // session id len
        body.extend_from_slice(&[0, 2, 0x13, 0x01]); // cipher len + one
        body.push(1);body.push(0); // compression
        body.extend_from_slice(&(ext.len() as u16).to_be_bytes());
        body.extend_from_slice(&ext);
        hs.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]);
        hs.extend_from_slice(&body);

        let mut rec = vec![0x16, 0x03, 0x01];
        rec.extend_from_slice(&(hs.len() as u16).to_be_bytes());
        rec.extend_from_slice(&hs);
        rec
    }
}

#[cfg(test)]
mod tests {
    use super::test_frames::*;

    #[test]
    fn pcap_headers_are_little_endian_and_record_carries_orig_len() {
        let global = pcap_global_header(256);
        assert_eq!(&global[0..4], &[0xd4, 0xc3, 0xb2, 0xa1]);
        assert_eq!(global.len(), 24);
        let record = pcap_record(1_760_000_000, 500, 1500, &[1, 2, 3]);
        assert_eq!(record.len(), 19);
        assert_eq!(u32::from_le_bytes(record[8..12].try_into().unwrap()), 3);
        assert_eq!(u32::from_le_bytes(record[12..16].try_into().unwrap()), 1500);
    }

    #[test]
    fn dns_query_names_are_extracted_and_responses_skipped() {
        let frame = eth_ip_udp53(&dns_query("WWW.Example.COM"));
        assert_eq!(dns_query_name(&frame).as_deref(), Some("www.example.com"));
        let mut response = dns_query("example.com");
        response[2] = 0x81; // qr=1
        assert_eq!(dns_query_name(&eth_ip_udp53(&response)), None);
        assert_eq!(dns_query_name(&eth_ip_tcp443(&client_hello("a.com"))), None);
        let mut truncated = eth_ip_udp53(&[0xab, 0xcd, 1, 0, 0, 1, 0, 0, 0, 0]);
        truncated.truncate(40);
        assert_eq!(dns_query_name(&truncated), None);
    }

    #[test]
    fn sni_is_extracted_from_client_hello_only() {
        let frame = eth_ip_tcp443(&client_hello("Shop.Example.org"));
        assert_eq!(tls_sni(&frame).as_deref(), Some("shop.example.org"));
        let hello = client_hello("Shop.Example.org");
        assert_eq!(sni_from_record(&hello).as_deref(), Some("shop.example.org"));
        assert_eq!(tls_record_len(&hello), Some(hello.len()));
        assert_eq!(tls_record_len(&hello[..3]), None);
        let mut not_hello = client_hello("a.com");
        not_hello[14 + 20] = 0x17; // application data
        assert_eq!(tls_sni(&eth_ip_tcp443(&not_hello)), None);
        assert_eq!(sni_from_record(&not_hello[14 + 20..]), None);
        let mut server = client_hello("a.com");
        server[14 + 20] = 0x16;
        server[14 + 20 + 5] = 0x02; // ServerHello
        assert_eq!(tls_sni(&eth_ip_tcp443(&server)), None);
    }

    #[test]
    fn http_heads_are_parsed_with_host_and_keepalive() {
        let request = b"GET /path?q=1 HTTP/1.1\r\nHost: Example.com:80\r\nUser-Agent: t\r\n\r\nbody";
        let head = parse_request_head(request).unwrap();
        assert_eq!(head.method, "GET");
        assert_eq!(head.host, "example.com");
        assert_eq!(head.path, "/path");
        assert!(!head.close);
        assert_eq!(head.head_len, request.len() - 4);

        let close = parse_request_head(b"GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n").unwrap();
        assert!(close.close);
        assert_eq!(parse_request_head(b"GET / HTTP/1.1\r\n\r\n"), None, "无 Host 的透明代理请求不可路由");
        assert_eq!(parse_request_head(b"GARBAGE"), None);

        let response = parse_response_head(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
        assert_eq!(response.unwrap().status, 200);
    }

    #[test]
    fn skip_list_matches_exact_and_parent_domains() {
        assert!(domain_skipped("a.bank.com", &["bank.com".into()]));
        assert!(domain_skipped("bank.com.", &["bank.com".into()]));
        assert!(!domain_skipped("notbank.com", &["bank.com".into()]));
        assert!(!domain_skipped("example.com", &[]));
    }

    #[test]
    fn rfc3339_formats_utc_dates_including_epoch_boundaries() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_760_000_000), "2025-10-09T08:53:20Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(4_102_444_799), "2099-12-31T23:59:59Z");
    }
}
