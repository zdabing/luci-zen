//! Bounded, passive application recognition. nDPI runs in a separate worker
//! executable; uloop never waits for recognition or a pipe read.
use std::{collections::{HashMap,HashSet,VecDeque}, io::{Read, Write}, os::fd::AsRawFd,
    process::{Command, Stdio}, sync::{Arc, atomic::{AtomicU32, Ordering}, mpsc}, thread};
use aya::{Ebpf, Pod, maps::{Array, HashMap as BpfHashMap, MapData, RingBuf}};
use crate::{app_usage::AppUsage, wan::Bytes};
use crate::app_rules::{self, Evidence};
use crate::app_rule_store::{Store,DomainRule};

const SAMPLE_SIZE: usize = 4096;
const FLOW_LIMIT: usize = 16_384;
const SAMPLE_BATCH: usize = 2048; // Drain up to one full 8 MiB kernel ring per tick.
const RESULT_BATCH: usize = 4096;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct FlowKey { mac: [u8; 6], family: u8, protocol: u8, client: [u8; 16], server: [u8; 16], client_port: u16, server_port: u16 }
unsafe impl Pod for FlowKey {}
#[repr(C)]
#[derive(Clone, Copy)]
struct FlowStats { first_seen: u64, last_seen: u64, download: u64, upload: u64, samples: u64, control_samples: u64 }
unsafe impl Pod for FlowStats {}
#[repr(C)]
#[derive(Clone, Copy)]
struct Sample { key: FlowKey, length: u32, first_seen: u64, time: u64, packet: [u8; SAMPLE_SIZE] }

#[derive(Clone)]
struct Classification {
    app: u32, name: String, identified: bool, limited: bool,
    native_app: u16, evidence: Evidence, source: &'static str,
    rule: Option<DomainRule>, conflict: bool,rule_version:String,candidate:bool,
}
impl Default for Classification {
    fn default() -> Self { Self { app: 0, name: "Unknown".into(), identified: false, limited:false,
        native_app:0,evidence:Evidence::default(),source:"none",rule:None,conflict:false,rule_version:String::new(),candidate:false } }
}
struct Flow {
    id: u64, first_seen: u64, previous: Bytes, last_seen: u64,
    classification: Option<Classification>, pending: Vec<(u64, Bytes)>,
    provisional: Vec<(u64, Bytes)>, diagnostic_host: Option<String>,feature_candidate:Option<String>,
}

impl Flow {
    fn accumulate(buckets: &mut Vec<(u64,Bytes)>, time: u64, bytes: Bytes) {
        let hour = crate::timeline::local_hour(time);
        if let Some((_,total)) = buckets.iter_mut().find(|(t,_)| crate::timeline::local_hour(*t) == hour) {
            total.download = total.download.saturating_add(bytes.download);
            total.upload = total.upload.saturating_add(bytes.upload);
        } else { buckets.push((time,bytes)); }
    }

    fn decide(&mut self, app: Classification, mac: &str, usage: &mut AppUsage) {
        for (time,bytes) in self.provisional.drain(..) {
            usage.reclassify_as(time,mac,app.app,&app.name,app.identified,bytes,app.source,&app.rule_version);
        }
        self.classification = Some(app);
    }

    fn account(&mut self, mac: &str, usage: &mut AppUsage, provisional: bool) {
        let (id,name,identified,source,version)=self.classification.as_ref()
            .map(|app|(app.app,app.name.as_str(),app.identified,app.source,app.rule_version.as_str())).unwrap_or((0,"Unknown",false,"unidentified",""));
        for (time,bytes) in self.pending.drain(..) {
            usage.record_as(time,mac,id,name,identified,bytes,source,version);
            if provisional { Self::accumulate(&mut self.provisional,time,bytes); }
        }
        // Bound per-connection reconciliation memory even for slow sessions
        // lasting days. Older provisional hours remain honest Unknown rows.
        while self.provisional.len() > 2 { self.provisional.remove(0); }
    }
}
enum ResultMessage { Ready(String), Detection(u64, Classification, bool), Failed }
struct Request { id: u64, time: u64, packet: Vec<u8> }

#[derive(Default,serde::Serialize)]
struct DiagnosticBucket {connections:u64,download:u64,upload:u64}
impl DiagnosticBucket {
    fn add(&mut self,bytes:Bytes) {
        self.connections+=1;self.download=self.download.saturating_add(bytes.download);
        self.upload=self.upload.saturating_add(bytes.upload);
    }
}
struct Worker {
    sender: Option<mpsc::SyncSender<Request>>, receiver: Option<mpsc::Receiver<ResultMessage>>,
    pid: Arc<AtomicU32>, handle: Option<thread::JoinHandle<()>>,
}

fn read_reply(reader: &mut impl Read, fd: i32, id: u64, timeout: i32) -> Result<(Classification, bool), ()> {
    let mut result = [0u8; 440];
    let mut offset = 0;
    while offset < result.len() {
        let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        if unsafe { libc::poll(&mut poll, 1, timeout) } <= 0 { return Err(()); }
        let n = reader.read(&mut result[offset..]).map_err(|_| ())?;
        if n == 0 { return Err(()); } offset += n;
        // Reject an old worker immediately rather than waiting for a v2 tail.
        if offset >= 4 && &result[..4] != b"ZAR2" {return Err(());}
    }
    if u64::from_be_bytes(result[4..12].try_into().unwrap()) != id || result[15] > 63 || result[14] & !7 != 0 || result[85] & !3 != 0 { return Err(()); }
    let app = u16::from_be_bytes([result[12],result[13]]);
    let mut name = std::str::from_utf8(&result[16..16+result[15] as usize]).map_err(|_| ())?.to_owned();
    if name.is_empty() {if app==0 {name="Unknown".into();} else {return Err(());}}
    let host_length=u16::from_be_bytes([result[86],result[87]]) as usize;
    if host_length>255 || !name.bytes().all(|c|c.is_ascii() && !c.is_ascii_control()) {return Err(());}
    let text=|start:usize,end:usize| -> Result<String,()> {
        let data=&result[start..end];let n=data.iter().position(|c|*c==0).ok_or(())?;
        if !data[..n].iter().all(|c|c.is_ascii() && !c.is_ascii_control()) {return Err(());}
        Ok(std::str::from_utf8(&data[..n]).map_err(|_|())?.to_owned())
    };
    let hostname=if result[85]&2!=0 {String::new()} else {
        std::str::from_utf8(&result[88..88+host_length]).ok()
            .and_then(app_rules::normalize_hostname).unwrap_or_default()
    };
    let evidence=Evidence {master_protocol:u16::from_be_bytes([result[80],result[81]]),
        app_protocol:u16::from_be_bytes([result[82],result[83]]),confidence:result[84],
        confidence_source:text(344,376)?,master_name:text(376,440)?,has_hostname:!hostname.is_empty(),
        hostname,budget_exhausted:result[85]&1!=0,hostname_truncated:result[85]&2!=0};
    let classification=Classification {app:u32::from(app),name,identified:result[14]&2!=0,limited:result[14]&4!=0,
        native_app:app,evidence,source:"ndpi",rule:None,conflict:false,rule_version:"6.0".into(),candidate:false};
    Ok((classification,result[14]&1!=0))
}

impl Worker {
    fn drain(&self) -> (Vec<ResultMessage>,bool) {
        let mut messages=Vec::new();let mut closed=false;
        let Some(receiver) = &self.receiver else { return (messages,true) };
        for _ in 0..RESULT_BATCH {
            match receiver.try_recv() {
                Ok(message)=>messages.push(message),
                Err(mpsc::TryRecvError::Empty)=>break,
                Err(mpsc::TryRecvError::Disconnected)=>{closed=true;break;},
            }
        }
        (messages,closed)
    }

    fn start(path: &str) -> Result<Self, String> {
        let mut child = Command::new(path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
            .spawn().map_err(|_| "Application recognition worker is unavailable".to_owned())?;
        let mut input = child.stdin.take().ok_or("Worker stdin")?;
        let mut output = child.stdout.take().ok_or("Worker stdout")?;
        let (sender, requests) = mpsc::sync_channel::<Request>(SAMPLE_BATCH);
        let (results, receiver) = mpsc::sync_channel(RESULT_BATCH);
        let pid = Arc::new(AtomicU32::new(child.id()));
        let thread_pid = pid.clone();
        let handle = thread::spawn(move || {
            let transact = |input: &mut std::process::ChildStdin, output: &mut std::process::ChildStdout, request: &Request| {
                let mut header = Vec::with_capacity(24);
                header.extend_from_slice(b"ZAP2"); header.extend_from_slice(&request.id.to_be_bytes());
                header.extend_from_slice(&request.time.to_be_bytes()); header.extend_from_slice(&(request.packet.len() as u32).to_be_bytes());
                input.write_all(&header).and_then(|_| input.write_all(&request.packet)).map_err(|_| ())?;
                let fd = output.as_raw_fd();
                read_reply(output, fd, request.id, if request.id == 1 { 30_000 } else { 2000 })
            };
            let handshake = Request { id: 1, time: 0, packet: Vec::new() };
            let initial = transact(&mut input, &mut output, &handshake);
            // Domain-rule IDs are verified against the pinned nDPI 6.0 build.
            let mut healthy = initial.as_ref().is_ok_and(|(version,done)|*done && version.name.starts_with("6.0."));
            let mut completed = HashSet::new();
            if healthy {if let Ok((version,_)) = initial { healthy = results.send(ResultMessage::Ready(version.name)).is_ok(); }}
            while healthy {
                let Ok(request) = requests.recv() else { break };
                // Packets queued before the daemon received a verdict no
                // longer need an IPC round trip or duplicate result message.
                if !request.packet.is_empty() && completed.contains(&request.id) { continue; }
                if request.packet.is_empty() { completed.remove(&request.id); }
                match transact(&mut input, &mut output, &request) {
                    Ok((app, done)) => {
                        if done && !request.packet.is_empty() {
                            completed.insert(request.id);
                            healthy = results.send(ResultMessage::Detection(request.id, app, done)).is_ok();
                        }
                    }
                    Err(_) => healthy = false,
                }
            }
            if !healthy { let _ = results.send(ResultMessage::Failed); }
            let _ = child.kill(); let _ = child.wait(); thread_pid.store(0, Ordering::Release);
        });
        Ok(Self { sender: Some(sender), receiver:Some(receiver), pid, handle: Some(handle) })
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.sender.take();
        // Unblock a worker delivering a full result queue before joining it.
        self.receiver.take();
        let pid = self.pid.load(Ordering::Acquire);
        if pid != 0 { unsafe { libc::kill(pid as i32, libc::SIGTERM); } }
        if let Some(handle) = self.handle.take() { let _ = handle.join(); }
    }
}

pub struct AppEngine {
    samples: Option<RingBuf<MapData>>, worker: Option<Worker>, flows: HashMap<FlowKey,Flow>,
    ids: HashMap<u64,FlowKey>, errors: [u64; 3], version: String,
    next_id: u64, pub active: bool, pub dropped: u64, pub failed: bool,
    releases: VecDeque<u64>, limited: u64,
    pending_sample: Option<Request>, backpressure: u64, stop_failed: u64,
    diagnostics_until: u64,
    pub rules:Store,pub dns:crate::app_dns::Cache,dns_ring:Option<RingBuf<MapData>>,pub dns_active:bool,dns_drops:[u64;2],dns_since:u64,
    realtime:HashMap<([u8;6],u32),Bytes>,realtime_at:u64,realtime_interval:u64,
}
impl AppEngine {
    pub fn start(bpf: &mut Ebpf) -> Self {
        Self::with_worker(bpf,"/usr/libexec/zen-appid")
    }

    fn with_worker(bpf: &mut Ebpf, path: &str) -> Self {
        let mut engine = Self { samples: None, worker: None, flows: HashMap::new(), ids: HashMap::new(), errors: [0; 3], version: String::new(), next_id: 2,
            active: false, dropped: 0, failed: false, releases:VecDeque::new(), limited:0,
            pending_sample:None,backpressure:0,stop_failed:0,diagnostics_until:0,
            rules:Store::load(std::path::Path::new("/etc/zen-traffic/app-rules.json")),dns:Default::default(),
            dns_ring:bpf.take_map("dns_samples").and_then(|map|RingBuf::try_from(map).ok()),dns_active:false,dns_drops:[0;2],dns_since:0,
            realtime:HashMap::new(),realtime_at:0,realtime_interval:1000 };
        // This process also holds transient samples. Never include them in
        // daemon core files, regardless of the system-wide dump policy.
        let core=libc::rlimit {rlim_cur:0,rlim_max:0};
        if unsafe {libc::setrlimit(libc::RLIMIT_CORE,&core)}!=0 {engine.failed=true;return engine;}
        match bpf.take_map("app_samples").ok_or("Missing application sample map".to_owned())
            .and_then(|map| RingBuf::try_from(map).map_err(|e| e.to_string()))
            .and_then(|samples| { engine.samples = Some(samples); Worker::start(path) }) {
            Ok(worker) => engine.worker = Some(worker),
            Err(error) => { engine.failed = true; eprintln!("[zen-trafficd] {error}"); }
        }
        engine
    }

    fn set_enabled(bpf: &mut Ebpf, enabled: bool) {
        if let Some(map) = bpf.map_mut("app_enabled") {
            if let Ok(mut array) = Array::<_,u32>::try_from(map) { let _ = array.set(0, u32::from(enabled), 0); }
        }
    }

    fn flow(&mut self, key: FlowKey, first_seen: u64) -> Option<&mut Flow> {
        if self.flows.get(&key).is_some_and(|flow| flow.first_seen > first_seen) { return None; }
        if self.flows.get(&key).is_some_and(|flow| flow.first_seen != first_seen) {
            if let Some(old) = self.flows.remove(&key) {
                self.ids.remove(&old.id);
                if old.classification.is_none() { self.releases.push_back(old.id); }
            }
        }
        if !self.flows.contains_key(&key) && (self.flows.len() >= FLOW_LIMIT || self.releases.len() >= FLOW_LIMIT) { return None; }
        if !self.flows.contains_key(&key) {
            let id = self.next_id; self.next_id = self.next_id.saturating_add(1);
            self.ids.insert(id, key);
            self.flows.insert(key, Flow { id, first_seen, previous: Bytes::default(), last_seen: first_seen,
                classification: None, pending: Vec::new(), provisional:Vec::new(),diagnostic_host:None,feature_candidate:None });
        }
        self.flows.get_mut(&key)
    }

    fn release_completed(&mut self) {
        while let Some(id) = self.releases.front().copied() {
            let sent = self.worker.as_ref().and_then(|w| w.sender.as_ref())
                .is_some_and(|sender| sender.try_send(Request { id,time:0,packet:Vec::new() }).is_ok());
            if !sent { break; }
            self.releases.pop_front();
        }
    }

    fn attribute(&mut self,key:&FlowKey,app:&mut Classification) {
        let generic=!app.identified||matches!(app.native_app,0|48|285)||crate::app_catalog::is_infrastructure(app.app,&app.name);
        if let Some(outcome)=self.rules.set.classify(app.native_app,!generic,&app.evidence) {
            app.conflict=outcome.conflict;app.candidate=outcome.candidate;
            if outcome.refine {
                let entry=crate::app_catalog::by_key(&outcome.rule.app).unwrap();
                app.app=entry.id;app.name=entry.name.into();app.identified=entry.category!="infrastructure";
                app.source=if entry.category=="infrastructure" {"infrastructure"}else{"dedicated_domain"};
                app.rule_version=self.rules.set.package.version.clone();
            }
            app.rule=Some(outcome.rule);
        }
        // DNS is a fallback, not an override: it is only consulted while the
        // flow is still generic. SNI often names a CDN host that has no rule
        // while the queried service (e.g. the video site) does, so a hostname
        // alone must not block this fallback.
        if self.dns_active&&generic&&app.source=="ndpi" {
            if let Some(rule)=self.dns.lookup(key.mac,(key.family,key.server),crate::state::now_mono_ms()) {
                let entry=crate::app_catalog::by_key(&rule.app).unwrap();
                app.app=entry.id;app.name=entry.name.into();app.identified=true;app.source="dns";
                app.rule_version=self.rules.set.package.version.clone();app.rule=Some(rule);
            }
        }
    }

    pub fn configure_rules_path(&mut self,path:&std::path::Path){self.rules=Store::load(path);self.dns.clear();}
    pub fn update_rules(&mut self,data:&str)->Result<(),String>{self.rules.update(data)?;self.dns.clear();Ok(())}
    pub fn rollback_rules(&mut self)->Result<(),String>{self.rules.rollback()?;self.dns.clear();Ok(())}
    pub fn set_dns(&mut self,bpf:&mut Ebpf,enabled:bool)->Result<(),String>{
        if enabled&&self.dns_ring.is_none(){return Err("dns_capture_unavailable".into());}
        let mut map=bpf.map_mut("dns_enabled").and_then(|map|Array::<_,u32>::try_from(map).ok()).ok_or("dns_capture_unavailable")?;
        map.set(0,0,0).map_err(|_|"dns_capture_failed")?;
        self.dns_active=false;self.dns.clear();
        if let Some(ring)=self.dns_ring.as_mut(){for _ in 0..256{if ring.next().is_none(){break;}}}
        self.dns_since=crate::state::now_mono_ms();
        map.set(0,u32::from(enabled),0).map_err(|_|"dns_capture_failed")?;
        self.dns_active=enabled;self.dns.clear();Ok(())
    }
    pub fn realtime(&self,mac:&str,now_ms:u64)->serde_json::Value {
        let rows:Vec<_>=self.realtime.iter().filter(|((device,_),_)|crate::persistence::mac_str(device)==mac)
            .map(|((_,id),bytes)|serde_json::json!({"id":id,"key":crate::app_catalog::key(*id),
                "download":bytes.download.saturating_mul(1000)/self.realtime_interval,
                "upload":bytes.upload.saturating_mul(1000)/self.realtime_interval})).collect();
        serde_json::json!({"mac":mac,"interval_ms":self.realtime_interval,"age_ms":now_ms.saturating_sub(self.realtime_at),"applications":rows})
    }
    pub fn rule_hits(&self)->Vec<serde_json::Value>{
        let mut hits=std::collections::BTreeMap::<String,DiagnosticBucket>::new();
        for flow in self.flows.values() {if let Some(rule)=flow.classification.as_ref().and_then(|app|app.rule.as_ref()){hits.entry(rule.id()).or_default().add(flow.previous);}}
        hits.into_iter().map(|(id,counts)|serde_json::json!({"rule_id":id,"scope":"live_connections","counts":counts})).collect()
    }

    pub fn pending_usage(&self, mac: &str, hour: u64) -> (Bytes,Bytes) {
        let (mut pending,mut provisional) = (Bytes::default(),Bytes::default());
        for (key,flow) in &self.flows {
            if flow.classification.is_some() || crate::persistence::mac_str(&key.mac) != mac { continue; }
            for (time,bytes) in &flow.provisional {
                if crate::timeline::local_hour(*time) == hour {
                    provisional.download = provisional.download.saturating_add(bytes.download);
                    provisional.upload = provisional.upload.saturating_add(bytes.upload);
                }
            }
            for (time,bytes) in flow.pending.iter().chain(&flow.provisional) {
                if crate::timeline::local_hour(*time) == hour {
                    pending.download = pending.download.saturating_add(bytes.download);
                    pending.upload = pending.upload.saturating_add(bytes.upload);
                }
            }
        }
        (pending,provisional)
    }

    fn enqueue_sample(&mut self, bpf: &mut Ebpf, request: Request) -> bool {
        let result = match self.worker.as_ref().and_then(|worker| worker.sender.as_ref()) {
            Some(sender) => sender.try_send(request),
            None => Err(mpsc::TrySendError::Disconnected(request)),
        };
        match result {
            Ok(()) => true,
            Err(mpsc::TrySendError::Full(request)) => {
                self.pending_sample=Some(request);self.backpressure=self.backpressure.saturating_add(1);false
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.failed=true;self.active=false;Self::set_enabled(bpf,false);false
            }
        }
    }

    /// Fast, bounded IPC/ring draining; device accounting keeps its 1s cadence.
    pub fn poll(&mut self, bpf: &mut Ebpf, usage: &mut AppUsage) {
        let detail_enabled=self.expire_diagnostics(crate::state::now_mono_ms());
        if self.dns_active {
            for _ in 0..128 {
                let sample=self.dns_ring.as_mut().and_then(|ring|ring.next()).and_then(|item| {
                    if item.len()!=std::mem::size_of::<Sample>(){return None;}
                    Some(unsafe {std::ptr::read_unaligned(item.as_ptr().cast::<Sample>())})
                });
                let Some(sample)=sample else{break;};
                if sample.length as usize>SAMPLE_SIZE||sample.time/1_000_000<self.dns_since{continue;}
                self.dns.observe_direction(crate::app_dns::Peer {mac:sample.key.mac,family:sample.key.family,client:sample.key.client,
                    server:sample.key.server,port:u16::from_be(sample.key.client_port)},
                    &sample.packet[..sample.length as usize],sample.time/1_000_000,&self.rules.set,sample.first_seen==1);
            }
        }
        // Drain already available decisions before attributing this tick.
        let (messages,closed)=self.worker.as_ref().map(Worker::drain).unwrap_or_default();
        for result in messages {
            match result {
                ResultMessage::Ready(version) => { self.version = version; self.active = true; Self::set_enabled(bpf, true); }
                ResultMessage::Failed => { self.active = false; self.failed = true; Self::set_enabled(bpf, false); }
                ResultMessage::Detection(id, mut app, done) => if done {
                    if let Some(key) = self.ids.get(&id).copied() {
                        self.attribute(&key,&mut app);
                        let mut epoch=None;
                        if let Some(flow) = self.flows.get_mut(&key) {
                            if flow.classification.is_none() {
                                if detail_enabled && app.evidence.has_hostname {flow.diagnostic_host=Some(app.evidence.hostname.clone());}
                                // Classification retains only metadata by default. Short-lived
                                // host details are held separately and never reach SQLite.
                                app.evidence.hostname=String::new();
                                if app.limited { self.limited = self.limited.saturating_add(1); }
                                flow.decide(app,&crate::persistence::mac_str(&key.mac),usage);
                                epoch=Some(flow.first_seen);
                                self.releases.push_back(id);
                            }
                        }
                        if let Some(epoch)=epoch {
                            let stopped=bpf.map_mut("app_verdicts")
                                .and_then(|map|BpfHashMap::<_,FlowKey,u64>::try_from(map).ok())
                                .is_some_and(|mut map|map.insert(key,epoch,0).is_ok());
                            if !stopped {self.stop_failed=self.stop_failed.saturating_add(1);}
                        }
                    }
                },
            }
        }
        // A full result queue can lose the final error message. Channel
        // closure must still disable sampling instead of claiming readiness.
        if closed {self.active=false;self.failed=true;Self::set_enabled(bpf,false);}
        self.release_completed();
        // Preserve the oldest unsent packet. In particular, never consume
        // and discard a ClientHello just because the worker queue is full.
        if self.failed || !self.releases.is_empty() {return;}
        if let Some(request)=self.pending_sample.take() {
            let needed=self.ids.get(&request.id).and_then(|key|self.flows.get(key))
                .is_some_and(|flow|flow.classification.is_none());
            if needed && !self.enqueue_sample(bpf,request) {return;}
        }
        // Bounded work per uloop tick. Overruns are diagnosed, never guessed.
        for _ in 0..SAMPLE_BATCH {
            let sample = self.samples.as_mut().and_then(|ring| ring.next()).and_then(|item| {
                if item.len() != std::mem::size_of::<Sample>() { return None; }
                Some(unsafe { std::ptr::read_unaligned(item.as_ptr().cast::<Sample>()) })
            });
            let Some(sample) = sample else { break };
            if sample.length as usize > SAMPLE_SIZE { self.dropped += 1; continue; }
            let feature=crate::app_features::candidate(&self.rules.set.features,&sample.packet[..sample.length as usize],sample.key.protocol,u16::from_be(sample.key.server_port)).map(|f|f.id.clone());
            let id = self.flow(sample.key, sample.first_seen).and_then(|flow| if flow.classification.is_none() { Some(flow.id) } else { None });
            if let Some(feature)=feature {if let Some(flow)=self.flows.get_mut(&sample.key){flow.feature_candidate=Some(feature);}}
            if let Some(id) = id {
                let request = Request { id, time: sample.time / 1_000_000, packet: sample.packet[..sample.length as usize].to_vec() };
                if !self.enqueue_sample(bpf,request) {break;}
            }
        }
    }

    pub fn tick(&mut self, bpf: &mut Ebpf, usage: &mut AppUsage, now: u64, mono_ms: u64) {
        self.poll(bpf,usage);
        let mut realtime=HashMap::<([u8;6],u32),Bytes>::new();
        self.dns.expire(mono_ms);
        let rows: Vec<_> = bpf.map_mut("app_flows").and_then(|map| BpfHashMap::<_,FlowKey,FlowStats>::try_from(map).ok())
            .map(|map| map.iter().take(FLOW_LIMIT).filter_map(Result::ok).collect()).unwrap_or_default();
        let mono = mono_ms * 1_000_000;
        let failed = self.failed;
        let mut expired = Vec::new();
        for (key, stats) in rows {
            let Some(flow) = self.flow(key, stats.first_seen) else { continue };
            flow.last_seen = stats.last_seen;
            let bytes = Bytes { download:stats.download.saturating_sub(flow.previous.download), upload:stats.upload.saturating_sub(flow.previous.upload) };
            flow.previous = Bytes { download:stats.download,upload:stats.upload };
            if bytes != Bytes::default() { Flow::accumulate(&mut flow.pending,now,bytes); }
            if flow.classification.is_none() && failed {
                flow.decide(Classification::default(),&crate::persistence::mac_str(&key.mac),usage);
            }
            let app=flow.classification.as_ref().map(|app|app.app).unwrap_or(0);
            let rate=realtime.entry((key.mac,app)).or_default();rate.download=rate.download.saturating_add(bytes.download);rate.upload=rate.upload.saturating_add(bytes.upload);
            let expired_flow = mono.saturating_sub(stats.last_seen) > 120_000_000_000;
            if flow.classification.is_some() || expired_flow {
                flow.account(&crate::persistence::mac_str(&key.mac),usage,false);
            } else if mono.saturating_sub(stats.first_seen) > 10_000_000_000 {
                // A soft accounting checkpoint, never a final DPI decision.
                flow.account(&crate::persistence::mac_str(&key.mac),usage,true);
            }
            if expired_flow { expired.push(key); }
        }
        if let Some(map) = bpf.map_mut("app_flows") {
            if let Ok(mut map) = BpfHashMap::<_,FlowKey,FlowStats>::try_from(map) {
                for key in &expired {
                    let _ = map.remove(key);
                    if let Some(flow) = self.flows.remove(key) {
                        self.ids.remove(&flow.id);
                        if flow.classification.is_none() { self.releases.push_back(flow.id); }
                    }
                }
            }
        }
        // Epoch-checked BPF verdicts never replace the kernel's accounting map.
        if let Some(map)=bpf.map_mut("app_verdicts") {
            if let Ok(mut map)=BpfHashMap::<_,FlowKey,u64>::try_from(map) {
                for key in expired {let _=map.remove(&key);}
            }
        }
        if let Some(map) = bpf.map_mut("app_errors") {
            if let Ok(map) = Array::<_,u64>::try_from(map) {
                for index in 0..3 { self.errors[index] = map.get(&(index as u32),0).unwrap_or(self.errors[index]); }
            }
        }
        if let Some(map)=bpf.map_mut("dns_errors").and_then(|map|Array::<_,u64>::try_from(map).ok()) {
            for index in 0..2 {self.dns_drops[index]=map.get(&(index as u32),0).unwrap_or(self.dns_drops[index]);}
        }
        self.realtime_interval=if self.realtime_at==0 {1000}else{mono_ms.saturating_sub(self.realtime_at).max(1)};
        self.realtime_at=mono_ms;self.realtime=realtime;
    }

    pub fn remove_device(&mut self, bpf: &mut Ebpf, mac: &str) {
        self.realtime.retain(|(device,_),_|crate::persistence::mac_str(device)!=mac);
        // Preserve absolute-flow baselines: deleting them would replay all
        // pre-reset connection bytes on the next BPF map read.
        let rows: Vec<_> = bpf.map_mut("app_flows").and_then(|map| BpfHashMap::<_,FlowKey,FlowStats>::try_from(map).ok())
            .map(|map| map.iter().filter_map(Result::ok).filter(|(key,_)| crate::persistence::mac_str(&key.mac) == mac).collect()).unwrap_or_default();
        // Include connections that arrived since the last tick and therefore
        // do not yet have a userspace flow entry.
        for (key,stats) in rows {
            if let Some(flow) = self.flow(key,stats.first_seen) {
                flow.pending.clear();
                flow.provisional.clear();
                flow.previous = Bytes { download:stats.download, upload:stats.upload };
            }
        }
    }

    pub fn finish(&mut self, bpf: &mut Ebpf, usage: &mut AppUsage) {
        Self::set_enabled(bpf, false);
        for (key,flow) in &mut self.flows {
            flow.account(&crate::persistence::mac_str(&key.mac),usage,false);
        }
        Self::set_enabled(bpf, false); self.worker.take(); self.active = false;
    }

    fn expire_diagnostics(&mut self,now_ms:u64) -> bool {
        if self.diagnostics_until!=0 && now_ms>=self.diagnostics_until {
            self.diagnostics_until=0;
            for flow in self.flows.values_mut() {flow.diagnostic_host=None;}
        }
        self.diagnostics_until!=0
    }

    pub fn set_diagnostics(&mut self,seconds:u64,now_ms:u64) -> Result<(),()> {
        if seconds>300 {return Err(());}
        // A new window does not retain domains captured by an earlier window.
        for flow in self.flows.values_mut() {flow.diagnostic_host=None;}
        self.diagnostics_until=if seconds==0 {0} else {now_ms.saturating_add(seconds*1000)};
        Ok(())
    }

    pub fn diagnostics(&mut self,mac:Option<&str>,limit:usize,now_ms:u64) -> serde_json::Value {
        let enabled=self.expire_diagnostics(now_ms);
        let mut categories=std::collections::BTreeMap::<&str,DiagnosticBucket>::new();
        for key in ["applications","protocols","infrastructure","unknown","pending"] {categories.insert(key,DiagnosticBucket::default());}
        let mut with_host=DiagnosticBucket::default();let mut no_tls_host=DiagnosticBucket::default();
        let mut conflicts=DiagnosticBucket::default();let mut native=DiagnosticBucket::default();
        let mut rules=DiagnosticBucket::default();let mut total=DiagnosticBucket::default();
        let mut budget=DiagnosticBucket::default();let mut limited=DiagnosticBucket::default();
        let mut truncated=DiagnosticBucket::default();let mut vendor=DiagnosticBucket::default();
        let mut details=Vec::new();
        for (key,flow) in &self.flows {
            let device=crate::persistence::mac_str(&key.mac);
            if mac.is_some_and(|mac|mac!=device) {continue;}
            let bytes=flow.previous;total.add(bytes);
            let kind=match &flow.classification {
                None=>"pending",Some(app) if app.app==0=>"unknown",
                Some(app) if crate::app_catalog::is_infrastructure(app.app,&app.name)=>"infrastructure",
                Some(app) if app.identified=>"applications",_=>"protocols",
            };
            categories.get_mut(kind).unwrap().add(bytes);
            if let Some(app)=&flow.classification {
                if app.evidence.has_hostname && !app.identified {with_host.add(bytes);}
                if !app.evidence.has_hostname && [app.evidence.master_protocol,app.evidence.app_protocol].iter().any(|id|matches!(id,91|188)) {no_tls_host.add(bytes);}
                if app.conflict {conflicts.add(bytes);}
                if app.evidence.budget_exhausted {budget.add(bytes);}
                if app.evidence.hostname_truncated {truncated.add(bytes);}
                if app.limited {limited.add(bytes);}
                if app.app==285 {vendor.add(bytes);}
                if app.identified {
                    if app.source=="dedicated_domain" {rules.add(bytes);} else {native.add(bytes);}
                }
            }
            if enabled {details.push((key,flow,device));}
        }
        details.sort_unstable_by_key(|(_,flow,_)|std::cmp::Reverse(flow.last_seen));
        let available=details.len();
        let connections:Vec<_>=details.into_iter().take(limit.min(100)).map(|(key,flow,mac)| {
            let app=flow.classification.as_ref();
            let address=|bytes:[u8;16]|if key.family==4 {
                std::net::Ipv4Addr::new(bytes[0],bytes[1],bytes[2],bytes[3]).to_string()
            } else {std::net::Ipv6Addr::from(bytes).to_string()};
            let evidence=app.map(|app|serde_json::json!({
                "native_app_id":app.native_app,"master_protocol":app.evidence.master_protocol,
                "master_protocol_name":app.evidence.master_name,"app_protocol":app.evidence.app_protocol,
                "confidence":app.evidence.confidence,"confidence_source":app.evidence.confidence_source,
                "hostname_available":app.evidence.has_hostname,"hostname":flow.diagnostic_host,
                "source":app.source,"conflict":app.conflict,"budget_exhausted":app.evidence.budget_exhausted,
                "hostname_truncated":app.evidence.hostname_truncated,
                "candidate":app.candidate,"rule_version":app.rule_version,
                "rule":app.rule.as_ref().map(|rule|serde_json::json!({"id":rule.id(),"domain":rule.domain,"app_id":rule.app_id(),"key":rule.app,
                    "match":rule.mode,"provenance":rule.source,"level":rule.level,"revision":rule.revision}))
            }));
            serde_json::json!({"id":flow.id,"mac":mac,"client_ip":address(key.client),
                "remote_ip":address(key.server),"client_port":u16::from_be(key.client_port),
                "remote_port":u16::from_be(key.server_port),"transport":if key.protocol==6 {"TCP"} else {"UDP"},
                "app_id":app.map(|app|app.app),"application":app.map(|app|&app.name),
                "finalized":app.is_some_and(|app|app.source!="none"),"limited":app.is_some_and(|app|app.limited),
                "feature_candidate":flow.feature_candidate,
                "download":flow.previous.download,"upload":flow.previous.upload,"evidence":evidence})
        }).collect();
        serde_json::json!({"scope":"live_connections","idle_retention_seconds":120,
            "byte_basis":"ebpf_connection_counters","persisted":false,"mac":mac,
            "engine":self.status(),"rules_version":self.rules.set.package.version,"total":total,"categories":categories,
            "facets":{"hostname_without_application":with_host,"tls_quic_without_hostname":no_tls_host,
                "conflicts":conflicts,"native_application":native,"domain_application":rules,
                "budget_exhausted":budget,"worker_limited":limited,"hostname_truncated":truncated,"generic_vendor":vendor},
            "detail":{"enabled":enabled,"remaining_seconds":self.diagnostics_until.saturating_sub(now_ms).div_ceil(1000),
                "hostname_scope":"decisions_received_during_window","available":available,
            "truncated":available>connections.len()},"connections":connections,"dns":self.dns.status(),"features":"diagnostic_candidates_only"})
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({"engine":"nDPI","version":self.version,"active":self.active,
            "failed":self.failed,"ipc_version":2,"rules_version":self.rules.set.package.version,"rule_error":self.rules.error,
            "dns_enabled":self.dns_active,"dns_queue_dropped":self.dns_drops[0],"dns_oversized":self.dns_drops[1],
            "queue_dropped":self.dropped.saturating_add(self.errors[1]),
            "kernel_queue_dropped":self.errors[1],"worker_queue_dropped":self.dropped,
            "worker_backpressure":self.backpressure,"sampler_stop_failed":self.stop_failed,
            "flow_overflow":self.errors[0],"unsupported_packets":self.errors[2],"flows":self.flows.len(),
            "worker_limited":self.limited,"pending_flows":self.flows.values().filter(|flow| flow.classification.is_none()).count()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsFd;
    use crate::{persistence::Db,state::{now_epoch,now_mono_ms}};

    fn packet(payload: &[u8],reverse: bool,flags: u8,port: u16) -> Vec<u8> {
        let mut bytes=vec![0;54+payload.len()];
        let client=[2,0,0,0,0,9];let router=[2,0,0,0,0,1];
        bytes[..6].copy_from_slice(if reverse {&client} else {&router});
        bytes[6..12].copy_from_slice(if reverse {&router} else {&client});
        bytes[12]=8;bytes[14]=0x45;
        bytes[16..18].copy_from_slice(&((40+payload.len()) as u16).to_be_bytes());
        bytes[22]=64;bytes[23]=6;
        bytes[26..30].copy_from_slice(if reverse {&[1,1,1,1]} else {&[192,168,1,9]});
        bytes[30..34].copy_from_slice(if reverse {&[192,168,1,9]} else {&[1,1,1,1]});
        bytes[34..36].copy_from_slice(&(if reverse {80} else {port}).to_be_bytes());
        bytes[36..38].copy_from_slice(&(if reverse {port} else {80}).to_be_bytes());
        bytes[38..42].copy_from_slice(&(if reverse {100u32} else if flags==2 {1} else {2}).to_be_bytes());
        bytes[42..46].copy_from_slice(&(if reverse {2u32} else if flags==2 {0} else {101}).to_be_bytes());
        bytes[46]=0x50;bytes[47]=flags;bytes[48]=0xff;bytes[49]=0xff;
        bytes[54..].copy_from_slice(payload);bytes
    }

    #[repr(C)]
    struct Run { fd:u32,retval:u32,in_len:u32,out_len:u32,input:u64,output:u64,repeat:u32,duration:u32 }
    fn run(fd:u32,packet:&[u8]) {
        let mut attr=Run{fd,retval:0,in_len:packet.len() as u32,out_len:0,input:packet.as_ptr() as u64,output:0,repeat:1,duration:0};
        assert_eq!(unsafe {libc::syscall(libc::SYS_bpf,10,&mut attr,std::mem::size_of::<Run>())},0,"{}",std::io::Error::last_os_error());
        assert_eq!(attr.retval,0);
    }

    #[test]
    fn wire_layout_matches_the_kernel_and_worker_protocols() {
        assert_eq!(std::mem::size_of::<FlowKey>(),44);
        assert_eq!(std::mem::size_of::<FlowStats>(),48);
        assert_eq!(std::mem::size_of::<Sample>(),4160);
    }

    #[test]
    fn worker_closure_is_detected_even_without_a_final_error_message() {
        let (results,receiver)=mpsc::sync_channel(1);
        results.send(ResultMessage::Ready("fixture".into())).unwrap();drop(results);
        let worker=Worker{sender:None,receiver:Some(receiver),pid:Arc::new(AtomicU32::new(0)),handle:None};
        let (messages,closed)=worker.drain();assert_eq!(messages.len(),1);assert!(closed);
    }

    #[test]
    #[ignore = "Requires a Linux test VM, compiled BPF object and actual nDPI worker"]
    fn real_kernel_samples_are_classified_and_reset_without_replay() {
        let path=std::env::var("ZEN_TEST_BPF").expect("ZEN_TEST_BPF");
        let worker=std::env::var("ZEN_TEST_APPID").expect("ZEN_TEST_APPID");
        let mut bpf=zen_bpf::load(std::path::Path::new(&path)).unwrap();
        let db=Db::open(":memory:").unwrap();let mut usage=AppUsage::load(&db).unwrap();
        let mut engine=AppEngine::with_worker(&mut bpf,&worker);
        let mut fds=Vec::new();
        for name in ["zen_ingress","zen_egress"] {
            let program:&mut aya::programs::SchedClassifier=bpf.program_mut(name).unwrap().try_into().unwrap();
            program.load().unwrap();fds.push(program.fd().unwrap().as_fd().as_raw_fd() as u32);
        }
        for _ in 0..600 {
            engine.tick(&mut bpf,&mut usage,now_epoch(),now_mono_ms());
            if engine.active {break;}
            assert!(!engine.failed,"worker startup failed");thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(engine.active,"nDPI worker not ready");
        let http=b"GET / HTTP/1.1\r\nHost: www.iqiyi.com\r\nUser-Agent: Zen\r\n\r\n";
        let packets=[packet(&[],false,2,50000),packet(&[],true,0x12,50000),packet(&[],false,0x10,50000),packet(http,false,0x18,50000)];
        for (i,p) in packets.iter().enumerate(){run(fds[usize::from(i==1)],p);}
        for _ in 0..28 {run(fds[0],&packet(&[],false,0x10,50000));}
        for _ in 0..200 {
            engine.tick(&mut bpf,&mut usage,now_epoch(),now_mono_ms());
            if usage.hours.values().any(|row| row.identified && row.name.to_lowercase().contains("iqiyi")) {break;}
            thread::sleep(std::time::Duration::from_millis(50));
        }
        let app=usage.hours.iter().find(|((_,_,id),_)| *id==54).expect("actual iQIYI classification");
        assert!(app.1.identified);
        assert_eq!(app.1.bytes.download,54);
        assert_eq!(app.1.bytes.upload,(30*54+packets[3].len()) as u64);
        // Include an unseen connection that arrives between the previous tick
        // and reset: it must not replay old bytes after the user's reset.
        run(fds[0],&packet(http,false,0x18,50001));
        usage.remove_device("02:00:00:00:00:09");
        engine.remove_device(&mut bpf,"02:00:00:00:00:09");
        engine.tick(&mut bpf,&mut usage,now_epoch(),now_mono_ms());
        assert!(usage.hours.is_empty());
        run(fds[0],&packet(http,false,0x18,50000));
        engine.tick(&mut bpf,&mut usage,now_epoch(),now_mono_ms());
        assert_eq!(usage.hours.values().map(|row|row.bytes.upload).sum::<u64>(),packets[3].len() as u64);
        engine.finish(&mut bpf,&mut usage);
    }
}
