//! Step 2：Aya 加载 zen_traffic.bpf.o，识别 TC 程序与 `devices` map。
//! Step 3（读侧）：遍历 devices HASH map（key=MAC，value=dev_stats）。

use std::path::Path;

use aya::maps::{HashMap, Map};
use aya::{Ebpf, EbpfLoader, Pod};

/// 与 poc/bpf/zen_traffic.bpf.c 中 `struct mac_key` 严格一致
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MacKey {
    pub b: [u8; 6],
}

/// 与 poc/bpf/zen_traffic.bpf.c 中 `struct dev_stats` 严格一致（9 × u64 = 72B）
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

// Aya 要求 key/value 实现 Pod trait（仅 marker，代表可安全按位读）
unsafe impl Pod for MacKey {}
unsafe impl Pod for DevStats {}

/// Step 2：加载 .bpf.o（BTF-defined maps 随对象自带；license=GPL 由 ELF 段读取）
pub fn load_object(path: &Path) -> Result<Ebpf, String> {
    EbpfLoader::new()
        .load_file(path)
        .map_err(|e| format!("加载 {path:?} 失败: {e}"))
}

/// Step 2 验证输出：识别对象内的程序与 map（期望 zen_ingress/zen_egress + devices/local_prefixes）
pub fn describe(bpf: &Ebpf) {
    println!("[spike] == BPF 对象清单 ==");
    for (name, prog) in bpf.programs() {
        let kind = if matches!(prog, aya::programs::Program::SchedClassifier(_)) {
            "SchedClassifier(tc)"
        } else {
            "other"
        };
        println!("[spike] program: {name} ({kind})");
    }
    for (name, map) in bpf.maps() {
        let kind = match map {
            Map::HashMap(_) => "HASH",
            Map::LpmTrie(_) => "LPM_TRIE",
            _ => "other",
        };
        println!("[spike] map: {name} ({kind})");
    }
}

pub struct DeviceTotals {
    pub devices: u64,
    pub wan_rx_b: u64,
    pub wan_tx_b: u64,
    pub lan_rx_b: u64,
    pub lan_tx_b: u64,
    pub sample: Vec<(String, DevStats)>, // 前 8 个条目用于日志
}

/// Step 3（读侧）：全量遍历 devices map（与 C daemon 1s 轮询同一读法）
pub fn read_devices(bpf: &mut Ebpf) -> Result<DeviceTotals, String> {
    let map = bpf
        .map_mut("devices")
        .ok_or_else(|| "devices map 未找到".to_string())?;
    let mut devs: HashMap<_, MacKey, DevStats> =
        HashMap::try_from(map).map_err(|e| format!("devices map 类型不匹配: {e}"))?;

    let mut t = DeviceTotals {
        devices: 0,
        wan_rx_b: 0,
        wan_tx_b: 0,
        lan_rx_b: 0,
        lan_tx_b: 0,
        sample: Vec::new(),
    };

    for row in devs.iter() {
        let (key, val) = row.map_err(|e| format!("devices 迭代失败: {e}"))?;
        t.devices += 1;
        t.wan_rx_b += val.wan_rx_b;
        t.wan_tx_b += val.wan_tx_b;
        t.lan_rx_b += val.lan_rx_b;
        t.lan_tx_b += val.lan_tx_b;
        if t.sample.len() < 8 {
            let mac = key
                .b
                .iter()
                .map(|x| format!("{x:02x}"))
                .collect::<Vec<_>>()
                .join(":");
            t.sample.push((mac, val));
        }
    }
    Ok(t)
}
