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
        // nft 1.1.6 can omit flowtable flags from JSON while its text output
        // correctly contains `flags offload`. Check that output before claiming
        // hardware was not requested.
        if status.software && !status.hardware_requested {
            if let Ok(text) = Command::new("nft").args(["list", "flowtables"]).output() {
                if text.status.success() {
                    status.hardware_requested = text_requests_hardware(&text.stdout);
                }
            }
        }
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

fn text_requests_hardware(data: &[u8]) -> bool {
    let text = String::from_utf8_lossy(data);
    let mut depth = 0usize;
    for line in text.lines().map(str::trim) {
        if depth == 0 {
            if line.starts_with("flowtable ") && line.contains('{') { depth = 1; }
            continue;
        }
        if line.starts_with("flags ") && line.split(|c: char| c.is_whitespace() || c == ',' || c == ';')
            .any(|word| word == "offload") { return true; }
        depth = depth.saturating_add(line.matches('{').count()).saturating_sub(line.matches('}').count());
    }
    false
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

    #[test]
    fn nft_116_text_preserves_flags_omitted_from_json() {
        let text = b"table inet fw4 {\n flowtable ft {\n devices = { eth0, eth1 }\n flags offload\n counter\n }\n}\n";
        assert!(text_requests_hardware(text));
        assert!(!text_requests_hardware(b"table inet fw4 {\n flowtable ft {\n counter\n }\n}\n"));
        assert!(!text_requests_hardware(b"table inet offload {\n flags offload\n}\n"));
    }
}
