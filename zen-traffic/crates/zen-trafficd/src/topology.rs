//! Resolve observation points before bridge/PPPoE software fastpaths bypass them.
use std::collections::BTreeSet;
use std::path::Path;

pub fn lan_ifaces(configured: &[String]) -> Result<Vec<String>, String> {
    resolve_lan(configured, &|name| {
        let path = Path::new("/sys/class/net").join(name).join("brif");
        if !path.exists() { return Ok(None); }
        let entries = std::fs::read_dir(&path).map_err(|e| format!("读取 {path:?}: {e}"))?;
        let mut ports = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| format!("读取 {path:?}: {e}"))?;
            ports.push(entry.file_name().to_string_lossy().into_owned());
        }
        Ok(Some(ports))
    })
}

fn resolve_lan(configured: &[String], ports: &impl Fn(&str) -> Result<Option<Vec<String>>, String>) -> Result<Vec<String>, String> {
    fn expand(name: &str, depth: usize, ports: &impl Fn(&str) -> Result<Option<Vec<String>>, String>, out: &mut BTreeSet<String>) -> Result<(), String> {
        if depth > 8 { return Err("LAN 网桥层级过深".into()); }
        match ports(name)? {
            Some(children) if !children.is_empty() => {
                for child in children { expand(&child, depth + 1, ports, out)?; }
            }
            // An empty bridge remains observable until netifd creates its ports.
            _ => { out.insert(name.to_owned()); }
        }
        Ok(())
    }
    let mut out = BTreeSet::new();
    for name in configured { expand(name, 0, ports, &mut out)?; }
    Ok(out.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_and_explicit_ports_are_observed_once() {
        let configured = ["br-lan", "eth0", "br-guest"].map(String::from);
        let resolved = resolve_lan(&configured, &|name| Ok(match name {
            "br-lan" => Some(vec!["eth0".into(), "wlan0".into()]),
            "br-guest" => Some(vec!["eth0.20".into()]),
            _ => None,
        })).unwrap();
        assert_eq!(resolved, ["eth0", "eth0.20", "wlan0"]);
    }

    #[test]
    fn topology_changes_replace_empty_bridge_without_double_counting() {
        let configured = vec!["br-lan".into()];
        assert_eq!(resolve_lan(&configured, &|_| Ok(Some(vec![]))).unwrap(), ["br-lan"]);
        assert_eq!(resolve_lan(&configured, &|name| Ok((name == "br-lan").then(|| vec!["eth0".into()]))).unwrap(), ["eth0"]);
        assert!(resolve_lan(&configured, &|_| Err("snapshot failed".into())).is_err());
        assert!(resolve_lan(&configured, &|_| Ok(Some(vec!["br-lan".into()]))).is_err());
    }
}
