//! tap.rs — eBPF tap 引擎（aya 0.14）。
//!
//! zen_capture.bpf.o 与 zen_traffic.bpf.o 完全独立：独立对象、独立 map、独立 attach。
//! 挂载必须先于 zen 会计程序（TCX: LinkOrder::first() 插链首；旧内核回落 netlink
//! priority 1），否则会计程序恒返回的 TC_ACT_OK 会终止 filter 链，capture 永远
//! 收不到包。capture 程序自身恒返回 TC_ACT_UNSPEC（= TCX_NEXT / 继续匹配）。
//! ringbuf 每 tick 排空一次；monotonic→epoch 偏移每次排空前校准。

use std::path::Path;

use aya::maps::ring_buf::RingBuf;
use aya::maps::{HashMap, MapData};
use aya::programs::links::LinkOrder;
use aya::programs::tc::{NlOptions, SchedClassifierLinkId, TcAttachOptions};
use aya::programs::{SchedClassifier, TcAttachType};
use aya::{Ebpf, EbpfLoader, Pod};

pub const CAP_FRAME_DATA: u32 = 256;
/// capture_frame 结构体在 BPF 侧的布局（严格对齐 zen_capture.bpf.c）
pub const FRAME_HEADER: usize = 24;
const RING_DRAIN_LIMIT: usize = 8192;

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct MacKey {
    pub b: [u8; 6],
}

unsafe impl Pod for MacKey {}

impl MacKey {
    pub fn to_str(&self) -> String {
        self.b.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(":")
    }
}

pub struct CapturedFrame {
    pub mac: MacKey,
    pub epoch_ns: u64,
    pub orig_len: u32,
    pub data: Vec<u8>,
}

pub struct TapEngine {
    bpf: Ebpf,
    ring: RingBuf<MapData>,
    links: Vec<(String, TcAttachType, SchedClassifierLinkId)>,
}

impl TapEngine {
    pub fn load(obj: &Path) -> Result<TapEngine, String> {
        let mut bpf = EbpfLoader::new()
            .load_file(obj)
            .map_err(|e| format!("加载 {obj:?} 失败: {e}"))?;
        let ring = RingBuf::try_from(
            bpf.take_map("capture_events").ok_or("capture_events map 未找到")?,
        )
        .map_err(|e| format!("capture_events ringbuf 不可用: {e}"))?;
        Ok(TapEngine { bpf, ring, links: Vec::new() })
    }

    pub fn enable(&mut self, mac: [u8; 6]) -> Result<(), String> {
        let map = self.bpf.map_mut("capture_enable").ok_or("capture_enable map 未找到")?;
        let mut entries: HashMap<_, MacKey, u8> =
            HashMap::try_from(map).map_err(|e| format!("capture_enable 类型不匹配: {e}"))?;
        entries
            .insert(MacKey { b: mac }, 1, 0)
            .map_err(|e| format!("capture_enable 写入失败: {e}"))
    }

    pub fn disable(&mut self, mac: [u8; 6]) {
        if let Some(map) = self.bpf.map_mut("capture_enable") {
            if let Ok(mut entries) = HashMap::<_, MacKey, u8>::try_from(map) {
                let _ = entries.remove(&MacKey { b: mac });
            }
        }
    }

    /// 在接口上挂载 ingress/egress 两个 capture 程序；部分失败时回滚本接口已挂的。
    pub fn attach_iface(&mut self, iface: &str) -> Result<(), String> {
        self.detach_iface(iface);
        zen_bpf::qdisc_ensure(iface).map(|_| ())?;
        for (name, ty) in
            [("zen_cap_ingress", TcAttachType::Ingress), ("zen_cap_egress", TcAttachType::Egress)]
        {
            match self.attach_program(name, iface, ty) {
                Ok(link) => self.links.push((iface.to_string(), ty, link)),
                Err(error) => {
                    self.detach_iface(iface);
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    fn attach_program(
        &mut self,
        name: &str,
        iface: &str,
        ty: TcAttachType,
    ) -> Result<SchedClassifierLinkId, String> {
        let prog: &mut SchedClassifier = self
            .bpf
            .program_mut(name)
            .ok_or_else(|| format!("program {name} 未找到"))?
            .try_into()
            .map_err(|_| format!("program {name} 不是 SchedClassifier"))?;
        if prog.fd().is_err() {
            prog.load().map_err(|e| format!("{name} load 失败: {e}"))?;
        }
        // TCX（内核 ≥6.6）：插链首，先于 zen 会计程序执行。
        match prog.attach_with_options(iface, ty, TcAttachOptions::TcxOrder(LinkOrder::first())) {
            Ok(link) => Ok(link),
            Err(tcx_error) => {
                // 旧内核回落 netlink，priority 1 先于会计程序的默认优先级。
                prog.attach_with_options(
                    iface,
                    ty,
                    TcAttachOptions::Netlink(NlOptions { priority: 1, ..NlOptions::default() }),
                )
                .map_err(|netlink_error| {
                    format!("{name} attach {iface} 失败: tcx={tcx_error} netlink={netlink_error}")
                })
            }
        }
    }

    pub fn detach_iface(&mut self, iface: &str) {
        let rest = self
            .links
            .extract_if(.., |(name, _, _)| name == iface)
            .collect::<Vec<_>>();
        for (_, ty, link) in rest {
            detach_link(&mut self.bpf, ty, link);
        }
    }

    pub fn detach_all(&mut self) {
        let links = std::mem::take(&mut self.links);
        for (_, ty, link) in links {
            detach_link(&mut self.bpf, ty, link);
        }
    }

    /// 排空 ringbuf（非阻塞），时间戳换算为 epoch ns。每次 tick 至多 RING_DRAIN_LIMIT 帧。
    pub fn drain(&mut self, offset_ns: u64) -> Vec<CapturedFrame> {
        let mut out = Vec::new();
        while out.len() < RING_DRAIN_LIMIT {
            let Some(item) = self.ring.next() else { break };
            let bytes: &[u8] = &item;
            if bytes.len() < FRAME_HEADER {
                continue;
            }
            let ts_ns = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
            let orig_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
            let cap_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap())
                .min(CAP_FRAME_DATA)
                .min((bytes.len() - FRAME_HEADER) as u32);
            let mut mac = [0u8; 6];
            mac.copy_from_slice(&bytes[16..22]);
            let end = FRAME_HEADER + cap_len as usize;
            out.push(CapturedFrame {
                mac: MacKey { b: mac },
                epoch_ns: ts_ns.saturating_add(offset_ns),
                orig_len,
                data: bytes[FRAME_HEADER..end].to_vec(),
            });
        }
        out
    }
}

fn detach_link(bpf: &mut Ebpf, ty: TcAttachType, link: SchedClassifierLinkId) {
    // 方向由调用方的会话记录给出，直接定位程序，避免在错误的程序上消耗 LinkId
    let name = match ty {
        TcAttachType::Ingress => "zen_cap_ingress",
        TcAttachType::Egress | TcAttachType::Custom(_) => "zen_cap_egress",
    };
    if let Some(program) = bpf.program_mut(name) {
        if let Ok(typed) = <&mut SchedClassifier>::try_from(program) {
            let _ = typed.detach(link);
        }
    }
}

/// monotonic → epoch 偏移（ns）。bpf_ktime_get_ns 基于 CLOCK_MONOTONIC。
pub fn monotonic_epoch_offset() -> u64 {
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    epoch.saturating_sub(ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64)
}

/// 启动时按名清理崩溃残留的 capture filter（TCX link 随进程释放，netlink 路径需显式清理）。
pub fn clean_stale(iface: &str) {
    for name in ["zen_cap_ingress", "zen_cap_egress"] {
        for ty in [TcAttachType::Ingress, TcAttachType::Egress] {
            let _ = aya::programs::tc::qdisc_detach_program(iface, ty, name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_layout_matches_the_bpf_struct() {
        // BPF: u64 ts, u32 orig, u32 cap, u8 mac[6], u8 pad[2], u8 data[256] = 280
        assert_eq!(FRAME_HEADER, 24);
        assert_eq!(FRAME_HEADER + CAP_FRAME_DATA as usize, 280);
        let mac = MacKey { b: [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff] };
        assert_eq!(mac.to_str(), "aa:bb:cc:dd:ee:ff");
    }

    #[test]
    fn monotonic_offset_is_non_negative_and_plausible() {
        let offset = monotonic_epoch_offset();
        // 系统纪元（1970）到现在的墙钟时间必须大于单调时钟读数
        assert!(offset > 1_500_000_000u64 * 1_000_000_000);
    }
}
