//! zen-bpf — zen_traffic.bpf.o 的 Aya 封装。
//!
//! 自 poc/rust-spike 的 bpf.rs / tc.rs 演进（spike Step 2/3 已验证的 API 面）：
//!   - load：EbpfLoader::new().load_file()（BTF-defined maps 随对象自带，license=GPL 由 ELF 读取）；
//!   - attach/detach：clsact qdisc + SchedClassifier ingress/egress，Aya 自管 Link；
//!   - read_devices：全量遍历 devices HASH（key=MAC，value=dev_stats）；
//!   - prefix_insert：local_prefixes LPM 写入（IPv4 以 v4-mapped 归一化，单表双栈）。
//!
//! 与 C PoC 的语义差异（有意为之，见 ARCHITECTURE.md 执行记录）：
//!   - C 版固定 pref/handle REPLACE 幂等 attach；Aya 走 netlink filter 语义，
//!     daemon 崩溃后 filter 可能残留 → 由 zen-trafficd 的 netlink 模块在启动时
//!     按名字清理本项目的旧 filter（zen_ingress/zen_egress），保证幂等；
//!   - C 版 pin maps 保持计数连续；Rust 版不 pin，重启后 BPF 计数从 0 开始，
//!     累计（今日/月/总量）由 SQLite checkpoint 恢复（崩溃丢失去 checkpoint 止，
//!     正常 SIGTERM 无损失）。

use std::path::Path;

use aya::maps::lpm_trie::Key as LpmTrieKey;
use aya::maps::{HashMap, LpmTrie, Map};
use aya::programs::{SchedClassifier, TcAttachType};
use aya::{Ebpf, EbpfLoader, Pod};

/// 与 bpf/zen_traffic.bpf.c 中 `struct mac_key` 严格一致
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct MacKey {
    pub b: [u8; 6],
}

/// 与 bpf/zen_traffic.bpf.c 中 `struct dev_stats` 严格一致（9 × u64 = 72B）
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct DevStats {
    pub last_seen: u64,
    pub wan_rx_b: u64,
    pub wan_rx_p: u64,
    pub wan_tx_b: u64,
    pub wan_tx_p: u64,
    pub lan_rx_b: u64,
    pub lan_rx_p: u64,
    pub lan_tx_b: u64,
    pub lan_tx_p: u64,
}

impl DevStats {
    /// 下载（rx）总字节：WAN + LAN-local
    pub fn rx_bytes(&self) -> u64 {
        self.wan_rx_b + self.lan_rx_b
    }
    /// 上传（tx）总字节
    pub fn tx_bytes(&self) -> u64 {
        self.wan_tx_b + self.lan_tx_b
    }
    pub fn rx_packets(&self) -> u64 {
        self.wan_rx_p + self.lan_rx_p
    }
    pub fn tx_packets(&self) -> u64 {
        self.wan_tx_p + self.lan_tx_p
    }
}

// Aya 要求 key/value 实现 Pod trait（仅 marker，代表可安全按位读）
unsafe impl Pod for MacKey {}
unsafe impl Pod for DevStats {}

impl MacKey {
    pub fn to_str(&self) -> String {
        self.b.iter().map(|x| format!("{x:02x}")).collect::<Vec<_>>().join(":")
    }
}

/// 加载 .bpf.o
pub fn load(path: &Path) -> Result<Ebpf, String> {
    EbpfLoader::new()
        .load_file(path)
        .map_err(|e| format!("加载 {path:?} 失败: {e}"))
}

/// 启动日志：识别对象内的程序与 map（期望 zen_ingress/zen_egress + devices/local_prefixes）
pub fn describe(bpf: &Ebpf) {
    for (name, prog) in bpf.programs() {
        let kind = if matches!(prog, aya::programs::Program::SchedClassifier(_)) {
            "SchedClassifier(tc)"
        } else {
            "other"
        };
        println!("[zen-bpf] program: {name} ({kind})");
    }
    for (name, map) in bpf.maps() {
        let kind = match map {
            Map::HashMap(_) => "HASH",
            Map::LpmTrie(_) => "LPM_TRIE",
            _ => "other",
        };
        println!("[zen-bpf] map: {name} ({kind})");
    }
}

/// 确保 clsact 存在；返回是否为本进程新建（决定退出时是否删除）。
pub fn qdisc_ensure(iface: &str) -> Result<bool, String> {
    match aya::programs::tc::qdisc_add_clsact(iface) {
        Ok(()) => Ok(true),
        Err(e) if e.raw_os_error() == Some(libc::EEXIST) => Ok(false),
        Err(e) => Err(format!("{iface}: 创建 clsact 失败: {e}")),
    }
}

/// 挂载单个 TC 程序（name = .bpf.o 内的 ELF 符号名），返回 LinkId 供显式 detach。
pub fn attach(
    bpf: &mut Ebpf,
    prog_name: &str,
    iface: &str,
    ty: TcAttachType,
) -> Result<aya::programs::tc::SchedClassifierLinkId, String> {
    let prog: &mut SchedClassifier = bpf
        .program_mut(prog_name)
        .ok_or_else(|| format!("program {prog_name} 未找到"))?
        .try_into()
        .map_err(|_| format!("program {prog_name} 不是 SchedClassifier"))?;

    prog.load()
        .map_err(|e| format!("{prog_name} load 失败: {e}"))?;

    prog.attach(iface, ty)
        .map_err(|e| format!("{prog_name} attach {iface}/{ty:?} 失败: {e}"))
}

/// 显式 detach（drop(Ebpf) 亦会自动完成同一动作）。
pub fn detach(
    bpf: &mut Ebpf,
    prog_name: &str,
    link: aya::programs::tc::SchedClassifierLinkId,
) -> Result<(), String> {
    let prog: &mut SchedClassifier = bpf
        .program_mut(prog_name)
        .ok_or_else(|| format!("program {prog_name} 未找到"))?
        .try_into()
        .map_err(|_| format!("program {prog_name} 不是 SchedClassifier"))?;
    prog.detach(link)
        .map_err(|e| format!("{prog_name} detach 失败: {e}"))
}

/// 退出清理：按名字卸载本项目 filter（与 daemon 启动时的 netlink 清理同一目标）。
/// aya 0.14 无 qdisc_remove_clsact：空 clsact qdisc 本体保留在接口上，无副作用。
pub fn qdisc_cleanup(iface: &str, created_by_us: bool) {
    let _ = created_by_us;
    for (ty, name) in [
        (TcAttachType::Ingress, "zen_ingress"),
        (TcAttachType::Egress, "zen_egress"),
    ] {
        if let Err(e) = aya::programs::tc::qdisc_detach_program(iface, ty, name) {
            // NotFound = 接口上无本项目残留 filter，属正常
            eprintln!("[zen-bpf] {iface}: 卸载 {name} 未执行: {e}");
        }
    }
}

pub struct DeviceRow {
    pub mac: MacKey,
    pub stats: DevStats,
}

/// 全量遍历 devices map（每 tick 一次；≤4096 条，实测设备远小于此）
pub fn read_devices(bpf: &mut Ebpf) -> Result<Vec<DeviceRow>, String> {
    let map = bpf
        .map_mut("devices")
        .ok_or_else(|| "devices map 未找到".to_string())?;
    let mut devs: HashMap<_, MacKey, DevStats> =
        HashMap::try_from(map).map_err(|e| format!("devices map 类型不匹配: {e}"))?;

    let mut out = Vec::new();
    for row in devs.iter() {
        let (key, val) = row.map_err(|e| format!("devices 迭代失败: {e}"))?;
        out.push(DeviceRow { mac: key, stats: val });
    }
    Ok(out)
}

/// 向 local_prefixes LPM 写入一条本地前缀。
/// IPv4：`::ffff:a.b.c.d`（prefixlen = 96 + mask）；IPv6：原生（prefixlen = mask）。
pub fn prefix_insert(bpf: &mut Ebpf, family: i32, bytes: &[u8], mask: u32) -> Result<(), String> {
    let map = bpf
        .map_mut("local_prefixes")
        .ok_or_else(|| "local_prefixes map 未找到".to_string())?;
    let mut trie: LpmTrie<_, [u8; 16], u8> =
        LpmTrie::try_from(map).map_err(|e| format!("local_prefixes 类型不匹配: {e}"))?;

    let mut data = [0u8; 16];
    let prefix_len;
    if family == libc::AF_INET {
        if bytes.len() < 4 || mask > 32 {
            return Err("非法 IPv4 前缀".into());
        }
        data[10] = 0xff;
        data[11] = 0xff;
        data[12..16].copy_from_slice(&bytes[..4]);
        prefix_len = 96 + mask;
    } else if family == libc::AF_INET6 {
        if bytes.len() < 16 || mask > 128 {
            return Err("非法 IPv6 前缀".into());
        }
        data.copy_from_slice(&bytes[..16]);
        prefix_len = mask;
    } else {
        return Err("非法地址族".into());
    }

    trie.insert(&LpmTrieKey::new(prefix_len, data), 1, 0)
        .map_err(|e| format!("LPM 插入失败: {e}"))?;
    Ok(())
}
