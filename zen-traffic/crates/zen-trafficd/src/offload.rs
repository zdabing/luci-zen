//! Report active nftables flowtables; a hardware request is not hardware activity.
use std::io::{BufRead, BufReader};
use std::process::Command;

#[derive(Clone, Copy, Default)]
pub struct Status {
    pub software: bool,
    pub hardware_requested: bool,
    pub hardware_active: bool,
    pub known: bool,
}

impl Status {
    pub fn mode(self) -> &'static std::ffi::CStr {
        if self.hardware_active { c"hw" }
        else if self.software { c"sw" }
        else if self.known { c"off" }
        else { c"unknown" }
    }

    pub fn detect() -> Self {
        let Ok(output) = Command::new("nft").args(["-j", "list", "flowtables"]).output() else { return Self::default() };
        if !output.status.success() { return Self::default(); }
        let mut status = parse_flowtables(&output.stdout);
        if status.hardware_requested {
            if let Ok(file) = std::fs::File::open("/proc/net/nf_conntrack") {
                // Keep probing bounded even on routers with very large tables.
                status.hardware_active = BufReader::new(file).lines().take(65_536)
                    .map_while(Result::ok).any(|line| line.split_whitespace().any(|word| word == "[HW_OFFLOAD]"));
            }
        }
        status
    }
}

fn parse_flowtables(data: &[u8]) -> Status {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(data) else { return Status::default() };
    let Some(entries) = value.get("nftables").and_then(|v| v.as_array()) else { return Status::default() };
    let mut status = Status { known: true, ..Status::default() };
    for entry in entries {
        let Some(table) = entry.get("flowtable") else { continue };
        status.software = true;
        status.hardware_requested |= table.get("flags").and_then(|v| v.as_array())
            .is_some_and(|flags| flags.iter().any(|flag| flag == "offload"));
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nft_flowtables_do_not_require_obsolete_proc_file() {
        let software = parse_flowtables(br#"{"nftables":[{"flowtable":{"name":"ft","flags":["counter"]}}]}"#);
        assert_eq!(software.mode(), c"sw");
        let hardware = parse_flowtables(br#"{"nftables":[{"flowtable":{"name":"ft","flags":["offload"]}}]}"#);
        assert_eq!(hardware.mode(), c"sw");
        assert!(hardware.hardware_requested && !hardware.hardware_active);
        assert_eq!(Status { hardware_active: true, ..hardware }.mode(), c"hw");
        assert_eq!(parse_flowtables(br#"{"nftables":[{"table":{"name":"fw4"}}]}"#).mode(), c"off");
        assert_eq!(parse_flowtables(b"permission denied").mode(), c"unknown");
    }
}
