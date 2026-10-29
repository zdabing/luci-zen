//! Bounded, passive application recognition. nDPI runs in a separate worker
//! executable; uloop never waits for recognition or a pipe read.
use std::{collections::HashMap, io::{Read, Write}, os::fd::AsRawFd,
    process::{Command, Stdio}, sync::{Arc, atomic::{AtomicU32, Ordering}, mpsc}, thread};
use aya::{Ebpf, Pod, maps::{Array, HashMap as BpfHashMap, MapData, RingBuf}};
use crate::{app_usage::AppUsage, wan::Bytes};

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
struct FlowStats { first_seen: u64, last_seen: u64, download: u64, upload: u64, samples: u64 }
unsafe impl Pod for FlowStats {}
#[repr(C)]
#[derive(Clone, Copy)]
struct Sample { key: FlowKey, length: u32, first_seen: u64, time: u64, packet: [u8; SAMPLE_SIZE] }

#[derive(Clone)]
struct Classification { app: u16, name: String, identified: bool }
impl Default for Classification {
    fn default() -> Self { Self { app: 0, name: "Unknown".into(), identified: false } }
}
struct Flow {
    id: u64, first_seen: u64, previous: Bytes, last_seen: u64,
    classification: Option<Classification>, pending: Vec<(u64, Bytes)>,
}
enum ResultMessage { Ready(String), Detection(u64, Classification, bool), Failed }
struct Request { id: u64, time: u64, packet: Vec<u8> }
struct Worker {
    sender: Option<mpsc::SyncSender<Request>>, receiver: mpsc::Receiver<ResultMessage>,
    pid: Arc<AtomicU32>, handle: Option<thread::JoinHandle<()>>,
}

fn read_reply(reader: &mut impl Read, fd: i32, id: u64, timeout: i32) -> Result<(Classification, bool), ()> {
    let mut result = [0u8; 80];
    let mut offset = 0;
    while offset < result.len() {
        let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        if unsafe { libc::poll(&mut poll, 1, timeout) } <= 0 { return Err(()); }
        let n = reader.read(&mut result[offset..]).map_err(|_| ())?;
        if n == 0 { return Err(()); } offset += n;
    }
    if &result[..4] != b"ZAR1" || u64::from_be_bytes(result[4..12].try_into().unwrap()) != id || result[15] > 64 { return Err(()); }
    let app = u16::from_be_bytes([result[12],result[13]]);
    let name = std::str::from_utf8(&result[16..16+result[15] as usize]).map_err(|_| ())?.to_owned();
    Ok((Classification { app, name, identified: result[14] & 2 != 0 }, result[14] & 1 != 0))
}

impl Worker {
    fn drain(&self) -> (Vec<ResultMessage>,bool) {
        let mut messages=Vec::new();let mut closed=false;
        for _ in 0..RESULT_BATCH {
            match self.receiver.try_recv() {
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
                header.extend_from_slice(b"ZAP1"); header.extend_from_slice(&request.id.to_be_bytes());
                header.extend_from_slice(&request.time.to_be_bytes()); header.extend_from_slice(&(request.packet.len() as u32).to_be_bytes());
                input.write_all(&header).and_then(|_| input.write_all(&request.packet)).map_err(|_| ())?;
                let fd = output.as_raw_fd();
                read_reply(output, fd, request.id, if request.id == 1 { 30_000 } else { 2000 })
            };
            let handshake = Request { id: 1, time: 0, packet: Vec::new() };
            let initial = transact(&mut input, &mut output, &handshake);
            let mut healthy = initial.is_ok();
            if let Ok((version,_)) = initial { let _ = results.try_send(ResultMessage::Ready(version.name)); }
            while healthy {
                let Ok(request) = requests.recv() else { break };
                match transact(&mut input, &mut output, &request) {
                    Ok((app, done)) => { let _ = results.try_send(ResultMessage::Detection(request.id, app, done)); }
                    Err(_) => healthy = false,
                }
            }
            if !healthy { let _ = results.try_send(ResultMessage::Failed); }
            let _ = child.kill(); let _ = child.wait(); thread_pid.store(0, Ordering::Release);
        });
        Ok(Self { sender: Some(sender), receiver, pid, handle: Some(handle) })
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.sender.take();
        let pid = self.pid.load(Ordering::Acquire);
        if pid != 0 { unsafe { libc::kill(pid as i32, libc::SIGTERM); } }
        if let Some(handle) = self.handle.take() { let _ = handle.join(); }
    }
}

pub struct AppEngine {
    samples: Option<RingBuf<MapData>>, worker: Option<Worker>, flows: HashMap<FlowKey,Flow>,
    ids: HashMap<u64,FlowKey>, errors: [u64; 3], version: String,
    next_id: u64, pub active: bool, pub dropped: u64, pub failed: bool,
}
impl AppEngine {
    pub fn start(bpf: &mut Ebpf) -> Self {
        Self::with_worker(bpf,"/usr/libexec/zen-appid")
    }

    fn with_worker(bpf: &mut Ebpf, path: &str) -> Self {
        let mut engine = Self { samples: None, worker: None, flows: HashMap::new(), ids: HashMap::new(), errors: [0; 3], version: String::new(), next_id: 2,
            active: false, dropped: 0, failed: false };
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
        if self.flows.get(&key).is_some_and(|flow| flow.first_seen != first_seen) {
            if let Some(old) = self.flows.remove(&key) { self.ids.remove(&old.id); }
        }
        if !self.flows.contains_key(&key) && self.flows.len() >= FLOW_LIMIT { return None; }
        if !self.flows.contains_key(&key) {
            let id = self.next_id; self.next_id = self.next_id.saturating_add(1);
            self.ids.insert(id, key);
            self.flows.insert(key, Flow { id, first_seen, previous: Bytes::default(), last_seen: first_seen,
                classification: None, pending: Vec::new() });
        }
        self.flows.get_mut(&key)
    }

    pub fn tick(&mut self, bpf: &mut Ebpf, usage: &mut AppUsage, now: u64, mono_ms: u64) {
        // Drain already available decisions before attributing this tick.
        let (messages,closed)=self.worker.as_ref().map(Worker::drain).unwrap_or_default();
        for result in messages {
            match result {
                ResultMessage::Ready(version) => { self.version = version; self.active = true; Self::set_enabled(bpf, true); }
                ResultMessage::Failed => { self.active = false; self.failed = true; Self::set_enabled(bpf, false); }
                ResultMessage::Detection(id, app, done) => if done {
                    if let Some(flow) = self.ids.get(&id).and_then(|key| self.flows.get_mut(key)) {
                        if flow.classification.is_none() { flow.classification = Some(app); }
                    }
                },
            }
        }
        // A full result queue can lose the final error message. Channel
        // closure must still disable sampling instead of claiming readiness.
        if closed {self.active=false;self.failed=true;Self::set_enabled(bpf,false);}
        // Bounded work per uloop tick. Overruns are diagnosed, never guessed.
        for _ in 0..SAMPLE_BATCH {
            let sample = self.samples.as_mut().and_then(|ring| ring.next()).and_then(|item| {
                if item.len() != std::mem::size_of::<Sample>() { return None; }
                Some(unsafe { std::ptr::read_unaligned(item.as_ptr().cast::<Sample>()) })
            });
            let Some(sample) = sample else { break };
            if sample.length as usize > SAMPLE_SIZE { self.dropped += 1; continue; }
            let id = self.flow(sample.key, sample.first_seen).and_then(|flow| if flow.classification.is_none() { Some(flow.id) } else { None });
            if let Some(id) = id {
                let request = Request { id, time: sample.time / 1_000_000, packet: sample.packet[..sample.length as usize].to_vec() };
                if !self.worker.as_ref().and_then(|worker| worker.sender.as_ref()).is_some_and(|sender| sender.try_send(request).is_ok()) {
                    self.dropped = self.dropped.saturating_add(1);
                }
            }
        }
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
            if bytes != Bytes::default() { flow.pending.push((now, bytes)); }
            if flow.classification.is_none() && (failed || mono.saturating_sub(stats.first_seen) > 10_000_000_000) {
                flow.classification = Some(Classification::default());
            }
            if let Some(app) = &flow.classification {
                for (time, bytes) in flow.pending.drain(..) {
                    usage.record(time, &crate::persistence::mac_str(&key.mac), app.app, &app.name, app.identified, bytes);
                }
            }
            if mono.saturating_sub(stats.last_seen) > 120_000_000_000 { expired.push(key); }
        }
        if let Some(map) = bpf.map_mut("app_flows") {
            if let Ok(mut map) = BpfHashMap::<_,FlowKey,FlowStats>::try_from(map) {
                for key in expired {
                    let _ = map.remove(&key);
                    if let Some(flow) = self.flows.remove(&key) { self.ids.remove(&flow.id); }
                }
            }
        }
        if let Some(map) = bpf.map_mut("app_errors") {
            if let Ok(map) = Array::<_,u64>::try_from(map) {
                for index in 0..3 { self.errors[index] = map.get(&(index as u32),0).unwrap_or(self.errors[index]); }
            }
        }
    }

    pub fn remove_device(&mut self, bpf: &mut Ebpf, mac: &str) {
        // Preserve absolute-flow baselines: deleting them would replay all
        // pre-reset connection bytes on the next BPF map read.
        let rows: Vec<_> = bpf.map_mut("app_flows").and_then(|map| BpfHashMap::<_,FlowKey,FlowStats>::try_from(map).ok())
            .map(|map| map.iter().filter_map(Result::ok).filter(|(key,_)| crate::persistence::mac_str(&key.mac) == mac).collect()).unwrap_or_default();
        // Include connections that arrived since the last tick and therefore
        // do not yet have a userspace flow entry.
        for (key,stats) in rows {
            if let Some(flow) = self.flow(key,stats.first_seen) {
                flow.pending.clear();
                flow.previous = Bytes { download:stats.download, upload:stats.upload };
            }
        }
    }

    pub fn finish(&mut self, bpf: &mut Ebpf, usage: &mut AppUsage) {
        Self::set_enabled(bpf, false);
        for (key,flow) in &mut self.flows {
            for (time,bytes) in flow.pending.drain(..) {
                usage.record(time, &crate::persistence::mac_str(&key.mac), 0, "Unknown", false, bytes);
            }
        }
        Self::set_enabled(bpf, false); self.worker.take(); self.active = false;
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({"engine":"nDPI","version":self.version,"active":self.active,
            "failed":self.failed,"queue_dropped":self.dropped.saturating_add(self.errors[1]),
            "flow_overflow":self.errors[0],"unsupported_packets":self.errors[2],"flows":self.flows.len()})
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
        assert_eq!(std::mem::size_of::<FlowStats>(),40);
        assert_eq!(std::mem::size_of::<Sample>(),4160);
    }

    #[test]
    fn worker_closure_is_detected_even_without_a_final_error_message() {
        let (results,receiver)=mpsc::sync_channel(1);
        results.send(ResultMessage::Ready("fixture".into())).unwrap();drop(results);
        let worker=Worker{sender:None,receiver,pid:Arc::new(AtomicU32::new(0)),handle:None};
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
