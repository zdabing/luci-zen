//! Outbound bot messages only. No listener or shell/RPC bridge. Scheduling and
//! durable deduplication stay on uloop; a bounded worker runs curl with verified
//! HTTPS and a ten-second deadline. Secrets travel over stdin, never argv/logs.
use std::{collections::HashMap, io::Write, process::{Command, Stdio}, sync::mpsc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::{persistence::Db, state::{DevState, local_date, time_synced}, wan::WanUsage};
use zen_bpf::MacKey;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Channel {
    pub enabled: bool,
    pub webhook: String,
    pub secret: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub enabled: bool,
    /// Empty means the upstream interface total; a MAC means attributed WAN.
    pub mac: String,
    pub metric: String,
    pub bytes: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub feishu: Channel,
    pub wecom: Channel,
    pub daily_enabled: bool,
    pub daily_time: String,
    pub rules: Vec<Rule>,
}

impl Default for Settings {
    fn default() -> Self { Self { enabled: false, feishu: Channel::default(), wecom: Channel::default(),
        daily_enabled: false, daily_time: "21:00".into(), rules: Vec::new() } }
}

/// Only official bot destinations. No redirects, userinfo, whitespace, query
/// injection or arbitrary URLs that could access router/LAN administrative APIs.
fn valid_webhook(name: &str, url: &str) -> bool {
    let prefix = if name == "feishu" { "https://open.feishu.cn/open-apis/bot/v2/hook/" }
        else { "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" };
    url.strip_prefix(prefix).is_some_and(|token| !token.is_empty() && token.len() <= 256
        && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
}

fn minute(time: &str) -> Option<u32> {
    if time.len() != 5 || time.as_bytes()[2] != b':' { return None; }
    let h: u32 = time[..2].parse().ok()?;
    let m: u32 = time[3..].parse().ok()?;
    if h > 23 || m > 59 { None } else { Some(h * 60 + m) }
}

impl Settings {
    fn validate(&self) -> Result<(), String> {
        if minute(&self.daily_time).is_none() { return Err("Invalid report time".into()); }
        for (name, channel) in [("feishu", &self.feishu), ("wecom", &self.wecom)] {
            if (!channel.webhook.is_empty() || channel.enabled) && !valid_webhook(name, &channel.webhook) {
                return Err(format!("Invalid {name} webhook"));
            }
            if channel.secret.len() > 256 || channel.secret.chars().any(char::is_control)
                || (name == "wecom" && !channel.secret.is_empty()) { return Err("Invalid signing secret".into()); }
        }
        if self.enabled && !self.feishu.enabled && !self.wecom.enabled { return Err("Enable a notification channel first".into()); }
        if self.rules.len() > 20 { return Err("At most 20 threshold rules".into()); }
        let mut ids = std::collections::HashSet::new();
        for rule in &self.rules {
            if rule.id.is_empty() || rule.id.len() > 40 || !rule.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || !ids.insert(&rule.id) { return Err("Invalid or duplicate rule ID".into()); }
            if !rule.mac.is_empty() && (crate::daemon::parse_mac(&rule.mac).is_none() || rule.mac != rule.mac.to_ascii_lowercase()) {
                return Err("Invalid device MAC".into());
            }
            if !["upload", "download", "total"].contains(&rule.metric.as_str()) || rule.bytes == 0 || rule.bytes > 1_125_899_906_842_624 {
                return Err("Invalid threshold".into());
            }
        }
        Ok(())
    }
    fn channel(&self, name: &str) -> Option<&Channel> {
        match name { "feishu" => Some(&self.feishu), "wecom" => Some(&self.wecom), _ => None }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Delivery {
    id: String, day: String, channel: String, kind: String, text: String,
    status: String, attempts: u8, next_at: u64, at: u64, error: String,
}

struct Job { id: String, channel_name: String, channel: Channel, text: String, epoch: u64 }
struct Outcome { id: String, result: Result<(), String> }

pub struct Notifications {
    settings: Settings,
    deliveries: Vec<Delivery>,
    jobs: mpsc::SyncSender<Job>,
    outcomes: mpsc::Receiver<Outcome>,
    inflight: Option<String>,
    last_eval: u64,
    last_dispatch: u64,
    last_test: u64,
    blocked_until: u64,
    /// Dirty results must commit before another message may be sent.
    dirty: bool,
}

impl Notifications {
    pub fn load(db: &Db) -> Result<Self, String> {
        let settings: Settings = db.setting("notifications_config")?.map(|s| serde_json::from_str(&s))
            .transpose().map_err(|_| "Invalid notification settings".to_owned())?.unwrap_or_default();
        settings.validate()?;
        let mut deliveries: Vec<Delivery> = db.setting("notifications_deliveries")?.map(|s| serde_json::from_str(&s))
            .transpose().map_err(|_| "Invalid delivery state".to_owned())?.unwrap_or_default();
        // An interrupted attempt retries at most twice. Successful events stay
        // deduplicated across restart; provider acknowledgements are not a
        // distributed transaction, so a crash after delivery can repeat once.
        for item in &mut deliveries {
            if item.status == "sending" { item.status = if item.attempts < 3 { "retry" } else { "failed" }.into(); }
        }
        let (jobs, receiver) = mpsc::sync_channel::<Job>(1);
        let (sender, outcomes) = mpsc::channel();
        std::thread::Builder::new().name("zen-notify".into()).spawn(move || {
            while let Ok(job) = receiver.recv() {
                let result = send(&job.channel_name, &job.channel, &job.text, job.epoch);
                if sender.send(Outcome { id: job.id, result }).is_err() { break; }
            }
        }).map_err(|_| "Unable to start notification worker".to_owned())?;
        Ok(Self { settings, deliveries, jobs, outcomes, inflight: None, last_eval: 0, last_dispatch: 0, last_test: 0, blocked_until: 0, dirty: false })
    }

    pub fn public(&self, wan: &WanUsage) -> Value {
        let mut config = serde_json::to_value(&self.settings).unwrap();
        for (name, channel) in [("feishu", &self.settings.feishu), ("wecom", &self.settings.wecom)] {
            config[name]["webhook"] = json!(""); config[name]["secret"] = json!("");
            config[name]["has_webhook"] = json!(!channel.webhook.is_empty());
            config[name]["has_secret"] = json!(!channel.secret.is_empty());
        }
        let recent: Vec<_> = self.deliveries.iter().rev().take(30).map(|d| json!({"id":d.id,"at":d.at,
            "channel":d.channel,"kind":d.kind,"status":d.status,"attempts":d.attempts,"error":d.error})).collect();
        json!({"config":config,"recent":recent,"internet_since":wan.daily_since,
            "today":wan.day,"network":wan.today("")})
    }

    pub fn configure(&mut self, db: &Db, input: &str) -> Result<(), String> {
        if input.len() > 16384 { return Err("Settings too large".into()); }
        let mut incoming: Settings = serde_json::from_str(input).map_err(|_| "Invalid notification settings".to_owned())?;
        for (next, old) in [(&mut incoming.feishu, &self.settings.feishu), (&mut incoming.wecom, &self.settings.wecom)] {
            // Blank password fields retain saved values; replacing a webhook
            // clears its old signature unless a new secret is supplied.
            if next.webhook.is_empty() { next.webhook.clone_from(&old.webhook);
                if next.secret.is_empty() { next.secret.clone_from(&old.secret); }
            }
            if next.secret == "-" { next.secret.clear(); }
        }
        incoming.validate()?;
        // Do not deliver queued alerts for rules that were just disabled.
        let mut deliveries = self.deliveries.clone();
        for d in &mut deliveries {
            if ["queued", "retry"].contains(&d.status.as_str()) { d.status = "cancelled".into(); }
        }
        db.save_settings(&[("notifications_config",serde_json::to_string(&incoming).unwrap()),
            ("notifications_deliveries",serde_json::to_string(&deliveries).unwrap())])?;
        self.settings = incoming; self.deliveries = deliveries; self.last_eval = 0; self.blocked_until = 0;
        Ok(())
    }

    fn persist(&self, db: &Db) -> Result<(), String> {
        db.save_setting("notifications_deliveries", &serde_json::to_string(&self.deliveries).unwrap())
    }

    fn enqueue(&mut self, day: &str, key: &str, kind: &str, text: &str, now: u64, only_channel: Option<&str>) {
        for name in ["feishu", "wecom"] {
            let channel = self.settings.channel(name).unwrap();
            if only_channel.map_or(!channel.enabled, |n| n != name) { continue; }
            let id = format!("{day}/{key}/{name}");
            if self.deliveries.iter().any(|d| d.id == id && d.status != "cancelled") { continue; }
            self.deliveries.retain(|d| d.id != id);
            self.deliveries.push(Delivery { id, day: day.into(), channel: name.into(), kind: kind.into(), text: text.into(),
                status: "queued".into(), attempts: 0, next_at: now, at: now, error: String::new() });
        }
    }

    fn evaluate(&mut self, wan: &WanUsage, devs: &HashMap<MacKey, DevState>, now: u64) {
        if !self.settings.enabled || !time_synced(now) || wan.daily_since == 0 { return; }
        let day = local_date(now);
        if day != wan.day { return; }
        for rule in self.settings.rules.clone() {
            if !rule.enabled { continue; }
            let usage = wan.today(&rule.mac);
            let value = match rule.metric.as_str() { "upload" => usage.upload, "download" => usage.download,
                _ => usage.download.saturating_add(usage.upload) };
            if value < rule.bytes { continue; }
            let name = if rule.mac.is_empty() { "整个网络".to_owned() } else {
                crate::daemon::parse_mac(&rule.mac).and_then(|m| devs.get(&m))
                    .and_then(|d| d.host.clone().or(d.ip4.clone())).unwrap_or(rule.mac.clone())
            };
            let metric = match rule.metric.as_str() { "upload" => "上传", "download" => "下载", _ => "总用量" };
            let text = format!("Zen 流量提醒\n{day} · {name}\n今日互联网{metric}已达 {}，设定值 {}\n上传 {} · 下载 {}\n{}",
                format_bytes(value), format_bytes(rule.bytes), format_bytes(usage.upload), format_bytes(usage.download), coverage(wan, &day));
            self.enqueue(&day, &rule.id, "threshold", &text, now, None);
        }
        if self.settings.daily_enabled && local_minute(now) >= minute(&self.settings.daily_time).unwrap() {
            let usage = wan.today("");
            let mut text = format!("Zen 每日流量报告\n{day} · 截至路由器本地时间 {:02}:{:02}\n整个网络：上传 {} · 下载 {}\n{}\n设备互联网用量前五：",
                local_minute(now)/60, local_minute(now)%60, format_bytes(usage.upload), format_bytes(usage.download), coverage(wan, &day));
            let mut devices: Vec<_> = wan.daily.iter().filter(|((d, mac), _)| d == &day && !mac.is_empty()).collect();
            devices.sort_by_key(|(_, b)| std::cmp::Reverse(b.download.saturating_add(b.upload)));
            for ((_, mac), b) in devices.iter().take(5) {
                let name = crate::daemon::parse_mac(mac).and_then(|m| devs.get(&m)).and_then(|d| d.host.as_deref()).unwrap_or(mac);
                text.push_str(&format!("\n{}：↑ {} · ↓ {}", name, format_bytes(b.upload), format_bytes(b.download)));
            }
            if devices.is_empty() { text.push_str("\n暂无设备流量"); }
            self.enqueue(&day, "daily-report", "daily", &text, now, None);
        }
    }

    pub fn test(&mut self, db: &Db, name: &str, now: u64, mono: u64) -> Result<(), String> {
        if !time_synced(now) { return Err("Router time is not synchronised".into()); }
        if self.last_test != 0 && mono.saturating_sub(self.last_test) < 60000 { return Err("Wait one minute before testing again".into()); }
        let channel = self.settings.channel(name).ok_or("Unknown channel")?;
        if !valid_webhook(name, &channel.webhook) { return Err("Save the webhook first".into()); }
        let old = self.deliveries.clone();
        self.enqueue(&local_date(now), &format!("test-{now}"), "test", "Zen 通知测试\n机器人连接成功。", now, Some(name));
        if let Err(e) = self.persist(db) { self.deliveries = old; return Err(e); }
        self.last_test = mono;
        Ok(())
    }

    pub fn tick(&mut self, db: &Db, wan: &WanUsage, devs: &HashMap<MacKey, DevState>, now: u64, mono: u64) {
        while let Ok(outcome) = self.outcomes.try_recv() {
            self.inflight = None;
            if let Some(d) = self.deliveries.iter_mut().find(|d| d.id == outcome.id) {
                d.at = now;
                match outcome.result {
                    Ok(()) => { d.status = "sent".into(); d.error.clear(); }
                    Err(e) => { d.error = e; d.status = if d.kind != "test" && d.attempts < 3 { "retry" } else { "failed" }.into();
                        d.next_at = now.saturating_add(if d.attempts == 1 { 60 } else { 300 }); }
                }
                self.dirty = true;
            }
        }
        // Bound write retries too: a full disk must not get one attempt/tick.
        if mono < self.blocked_until || mono.saturating_sub(self.last_dispatch) < 5000 { return; }
        self.last_dispatch = mono;
        if self.dirty {
            if self.persist(db).is_err() { self.blocked_until = mono.saturating_add(30000); return; }
            self.dirty = false;
        }
        if self.last_eval == 0 || mono.saturating_sub(self.last_eval) >= 30000 {
            self.last_eval = mono;
            let old = self.deliveries.clone();
            let cutoff = crate::state::date_shift(&local_date(now), 30);
            self.deliveries.retain(|d| d.day >= cutoff);
            self.evaluate(wan, devs, now);
            // Event writes only, not a periodic no-op SQLite write.
            if serde_json::to_string(&old).unwrap() != serde_json::to_string(&self.deliveries).unwrap()
                && self.persist(db).is_err() { self.deliveries = old; self.blocked_until = mono.saturating_add(30000); return; }
        }
        if self.inflight.is_some() || !time_synced(now) { return; }
        let day = local_date(now);
        let next = self.deliveries.iter().position(|d| d.day == day && d.next_at <= now && d.attempts < 3
            && ["queued", "retry"].contains(&d.status.as_str())
            && (d.kind == "test" || (self.settings.enabled && self.settings.channel(&d.channel).is_some_and(|c| c.enabled))));
        let Some(index) = next else { return; };
        let old = self.deliveries[index].clone();
        let d = &mut self.deliveries[index]; d.attempts += 1; d.at = now; d.status = "sending".into();
        // Reserve durably before delivery, including on a storage failure.
        if self.persist(db).is_err() { self.deliveries[index] = old; self.blocked_until = mono.saturating_add(30000); return; }
        let d = &self.deliveries[index];
        let job = Job { id: d.id.clone(), channel_name: d.channel.clone(), channel: self.settings.channel(&d.channel).unwrap().clone(), text: d.text.clone(), epoch: now };
        if self.jobs.try_send(job).is_ok() { self.inflight = Some(d.id.clone()); }
        else { self.deliveries[index] = old; self.dirty = true; }
    }
}

fn local_minute(epoch: u64) -> u32 {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let t = epoch as libc::time_t;
    unsafe { libc::localtime_r(&t, &mut tm) };
    (tm.tm_hour * 60 + tm.tm_min) as u32
}
fn format_bytes(bytes: u64) -> String {
    if bytes >= 1 << 30 { format!("{:.2} GiB", bytes as f64 / (1u64 << 30) as f64) }
    else { format!("{:.1} MiB", bytes as f64 / (1u64 << 20) as f64) }
}
fn coverage(wan: &WanUsage, day: &str) -> &'static str {
    if local_date(wan.daily_since) == day { "今日记录从功能启用时开始，未满整日；不含局域网传输。" }
    else { "统计范围：互联网流量，不含局域网传输。" }
}

fn payload(name: &str, channel: &Channel, text: &str, epoch: u64) -> Value {
    if name == "wecom" { return json!({"msgtype":"text","text":{"content":text}}); }
    let mut body = json!({"msg_type":"text","content":{"text":text}});
    if !channel.secret.is_empty() {
        use base64::Engine;
        use hmac::Mac;
        let key = format!("{epoch}\n{}", channel.secret);
        let hmac = hmac::Hmac::<sha2::Sha256>::new_from_slice(key.as_bytes()).unwrap();
        body["timestamp"] = json!(epoch.to_string());
        body["sign"] = json!(base64::engine::general_purpose::STANDARD.encode(hmac.finalize().into_bytes()));
    }
    body
}

fn response(name: &str, body: &[u8]) -> Result<(), String> {
    let data: Value = serde_json::from_slice(body).map_err(|_| "Invalid robot response".to_owned())?;
    let code = if name == "wecom" { data.get("errcode") }
        else { data.get("code").or_else(|| data.get("StatusCode")) };
    match code.and_then(Value::as_i64) {
        Some(0) => Ok(()), Some(code) => Err(format!("Robot rejected message (code {code})")),
        None => Err("Missing robot acknowledgement".into()),
    }
}

fn config_escape(s: &str) -> String { s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r") }
fn send(name: &str, channel: &Channel, text: &str, epoch: u64) -> Result<(), String> {
    let mut command = Command::new("/usr/bin/curl");
    command.arg("--disable");
    send_command(name, channel, text, epoch, &mut command)
}

fn send_command(name: &str, channel: &Channel, text: &str, epoch: u64, command: &mut Command) -> Result<(), String> {
    if !valid_webhook(name, &channel.webhook) { return Err("Invalid webhook".into()); }
    let config = format!("url = \"{}\"\ndata-binary = \"{}\"\n", config_escape(&channel.webhook), config_escape(&payload(name, channel, text, epoch).to_string()));
    let mut child = command.args(["--silent", "--fail-with-body", "--proto", "=https",
        "--connect-timeout", "5", "--max-time", "10", "--max-filesize", "65536", "--proxy", "", "--request", "POST",
        "--header", "Content-Type: application/json; charset=utf-8", "--config", "-"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "HTTPS sender unavailable".to_owned())?;
    if child.stdin.take().unwrap().write_all(config.as_bytes()).is_err() {
        let _ = child.kill(); let _ = child.wait(); return Err("Unable to start HTTPS request".into());
    }
    let output = child.wait_with_output().map_err(|_| "HTTPS delivery failed".to_owned())?;
    if !output.status.success() { return Err(format!("HTTPS delivery failed (curl code {}); check network, certificate and webhook", output.status.code().unwrap_or(-1))); }
    response(name, &output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::mac_str;
    #[test]
    fn payload_and_acknowledgement_match_robot_protocols() {
        let channel = Channel { secret: "secret".into(), ..Default::default() };
        let feishu = payload("feishu", &channel, "中文\n\"quote\"", 1700000000);
        assert_eq!(feishu["timestamp"], "1700000000");
        assert_eq!(feishu["sign"], "fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA=");
        assert_eq!(feishu["content"]["text"], "中文\n\"quote\"");
        assert_eq!(payload("wecom", &channel, "hello", 1), json!({"msgtype":"text","text":{"content":"hello"}}));
        assert!(response("feishu", br#"{"code":0}"#).is_ok());
        assert!(response("feishu", br#"{"StatusCode":0}"#).is_ok());
        assert!(response("wecom", br#"{"errcode":0}"#).is_ok());
        for body in [br#"{"code":19021}"#.as_slice(), b"{}", b"not JSON"] { assert!(response("feishu", body).is_err()); }
        assert!(response("wecom", br#"{"errcode":93000}"#).is_err());
    }
    #[test]
    fn settings_validate_destinations_rules_and_hide_secrets() {
        let db = Db::open(":memory:").unwrap();
        let wan = WanUsage::load(&db, crate::state::MIN_SYNC_EPOCH).unwrap();
        let mut n = Notifications::load(&db).unwrap();
        n.settings.feishu.webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/token".into();
        n.settings.feishu.secret = "hidden".into();
        let public = n.public(&wan).to_string(); assert!(!public.contains("hidden")); assert!(!public.contains("/hook/token"));
        assert!(valid_webhook("feishu", &n.settings.feishu.webhook));
        for bad in ["http://10.0.0.1/", "https://open.feishu.cn@10.0.0.1/", "https://open.feishu.cn/open-apis/bot/v2/hook/a\n", "https://open.feishu.cn/open-apis/bot/v2/hook/a?x=y"] {
            assert!(!valid_webhook("feishu", bad));
        }
        assert!(minute("24:00").is_none()); assert!(minute("x:00").is_none()); assert_eq!(minute("21:30"), Some(1290));
        // The masked UI's blank fields must preserve the actual saved secret.
        n.configure(&db, &serde_json::to_string(&Settings::default()).unwrap()).unwrap();
        assert_eq!(n.settings.feishu.secret, "hidden");
    }
    #[test]
    fn wan_thresholds_and_daily_report_deduplicate_across_restart() {
        let db = Db::open(":memory:").unwrap(); let epoch = crate::state::MIN_SYNC_EPOCH + 86400;
        let mut wan = WanUsage::load(&db, epoch).unwrap();
        let mac = MacKey { b: [2,0,0,0,0,1] }; wan.device_delta(mac, 100, 10); wan.interface_delta(130, 20);
        let mut n = Notifications::load(&db).unwrap();
        n.settings.enabled = true; n.settings.feishu.enabled = true;
        n.settings.feishu.webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/token".into();
        n.settings.daily_enabled = true; n.settings.daily_time = "00:00".into();
        n.settings.rules = vec![Rule { id:"network".into(), enabled:true, mac:String::new(), metric:"download".into(), bytes:120 },
            Rule { id:"device".into(), enabled:true, mac:mac_str(&mac.b), metric:"upload".into(), bytes:15 }];
        db.save_setting("notifications_config", &serde_json::to_string(&n.settings).unwrap()).unwrap();
        n.evaluate(&wan, &HashMap::new(), epoch); assert_eq!(n.deliveries.len(), 2); // network + report, device has only 10
        wan.device_delta(mac, 0, 5); n.evaluate(&wan, &HashMap::new(), epoch); assert_eq!(n.deliveries.len(), 3);
        for d in &mut n.deliveries { d.status = "sent".into(); }
        n.persist(&db).unwrap(); let mut restarted = Notifications::load(&db).unwrap();
        restarted.evaluate(&wan, &HashMap::new(), epoch); assert_eq!(restarted.deliveries.len(), 3);
        wan.set_day(epoch + 86400); wan.interface_delta(200, 1);
        restarted.evaluate(&wan, &HashMap::new(), epoch + 86400); assert_eq!(restarted.deliveries.len(), 5);
    }

    #[test]
    fn failed_settings_transaction_preserves_channels_and_queued_events() {
        let db = Db::open(":memory:").unwrap();
        let mut n = Notifications::load(&db).unwrap();
        db.conn_for_test_reject_settings();
        let mut config = Settings::default(); config.daily_enabled = true;
        assert!(n.configure(&db, &serde_json::to_string(&config).unwrap()).is_err());
        assert!(!n.settings.daily_enabled); assert!(db.setting("notifications_config").unwrap().is_none());
        db.conn_for_test_allow_settings();
        n.configure(&db, &serde_json::to_string(&config).unwrap()).unwrap();
        assert!(n.settings.daily_enabled);
    }

    /// Exercise the actual curl stdin transport with a local TLS robot fixture.
    /// The official hostname stays in the URL and certificate verification is
    /// required; connect-to changes only the test socket destination.
    #[test]
    #[cfg(unix)]
    fn actual_https_transport_verifies_certificates_payload_and_provider_errors() {
        use std::io::{BufRead, BufReader};
        let dir = std::env::temp_dir().join(format!("zen-notify-tls-{}-{}", std::process::id(), crate::state::now_mono_ms()));
        std::fs::create_dir(&dir).unwrap();
        struct Fixture { dir: std::path::PathBuf, process: Option<std::process::Child> }
        impl Drop for Fixture {
            fn drop(&mut self) { if let Some(p) = &mut self.process { let _ = p.kill(); let _ = p.wait(); }
                let _ = std::fs::remove_dir_all(&self.dir); }
        }
        let mut fixture = Fixture { dir: dir.clone(), process: None };
        let cert = dir.join("cert.pem"); let key = dir.join("key.pem"); let captured = dir.join("requests.jsonl");
        assert!(Command::new("openssl").args(["req","-x509","-newkey","rsa:2048","-nodes","-days","1",
            "-subj","/CN=open.feishu.cn","-addext","subjectAltName=DNS:open.feishu.cn,DNS:qyapi.weixin.qq.com",
            "-keyout"]).arg(&key).arg("-out").arg(&cert).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success());
        let script = r#"
import http.server,ssl,sys,json
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  data=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  with open(sys.argv[3],'a',encoding='utf-8') as f: f.write(json.dumps({'path':self.path,'data':data},ensure_ascii=False)+'\n')
  code=93000 if 'reject' in self.path else 0
  answer=json.dumps({'code':code} if 'hook/' in self.path else {'errcode':code}).encode()
  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(answer)));self.end_headers();self.wfile.write(answer)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(sys.argv[1],sys.argv[2])
server.socket=ctx.wrap_socket(server.socket,server_side=True)
print(server.server_port,flush=True);server.serve_forever()
"#;
        let mut server = Command::new("python3").args(["-u","-c",script]).arg(&cert).arg(&key).arg(&captured)
            .stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let mut port = String::new(); BufReader::new(server.stdout.take().unwrap()).read_line(&mut port).unwrap();
        let port: u16 = port.trim().parse().unwrap(); fixture.process = Some(server);
        for name in ["feishu", "wecom"] {
            let host = if name == "feishu" { "open.feishu.cn" } else { "qyapi.weixin.qq.com" };
            let prefix = if name == "feishu" { "https://open.feishu.cn/open-apis/bot/v2/hook/" } else { "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" };
            let mut channel = Channel { enabled:true, webhook:format!("{prefix}token"), secret:if name == "feishu" { "secret".into() } else { String::new() } };
            let make_command = |trusted: bool| { let mut c = Command::new("/usr/bin/curl"); c.arg("--disable");
                c.args(["--connect-to",&format!("{host}:443:127.0.0.1:{port}")]);
                if trusted { c.arg("--cacert").arg(&cert); } c };
            assert_eq!(send_command(name,&channel,"Zen 中文\n\"quotes\" \\slashes",1700000000,&mut make_command(true)),Ok(()));
            assert!(send_command(name,&channel,"Zen",1700000000,&mut make_command(false)).is_err(),"Untrusted certificate must fail");
            channel.webhook=format!("{prefix}reject");
            assert!(send_command(name,&channel,"Zen",1700000000,&mut make_command(true)).is_err(),"HTTP 200 with provider error is not success");
        }
        let requests: Vec<Value> = std::fs::read_to_string(&captured).unwrap().lines().map(|s| serde_json::from_str(s).unwrap()).collect();
        assert_eq!(requests.len(),4,"TLS failures must not send an HTTP payload");
        assert_eq!(requests[0]["data"]["content"]["text"],"Zen 中文\n\"quotes\" \\slashes");
        assert_eq!(requests[0]["data"]["sign"],"fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA=");
        assert_eq!(requests[2]["data"]["text"]["content"],"Zen 中文\n\"quotes\" \\slashes");
    }
}
