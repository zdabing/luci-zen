//! A real kernel regression, enabled by CI with a compiled BPF object and root.
use std::{os::fd::{AsFd, AsRawFd}, path::Path, process::Command};
use aya::programs::{SchedClassifier, TcAttachType};

struct Interfaces(Vec<String>);
impl Drop for Interfaces {
    fn drop(&mut self) {
        for name in &self.0 {
            let _ = Command::new("ip").args(["link", "delete", name]).output();
        }
    }
}

fn program_fd(bpf: &mut aya::Ebpf, name: &str) -> i32 {
    let prog: &mut SchedClassifier = bpf.program_mut(name).unwrap().try_into().unwrap();
    prog.fd().unwrap().as_fd().as_raw_fd()
}

#[test]
fn same_program_attaches_to_two_interfaces_and_links_detach_independently() {
    let Some(object) = std::env::var_os("ZEN_BPF_TEST_OBJECT") else {
        eprintln!("Kernel fixture not enabled; set ZEN_BPF_TEST_OBJECT and run as root");
        return;
    };
    let mut interfaces = Interfaces(Vec::new());
    for suffix in ["a", "b"] {
        let name = format!("zt{}{}", std::process::id(), suffix);
        let result = Command::new("ip").args(["link", "add", &name, "type", "dummy"]).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        interfaces.0.push(name);
    }
    let mut bpf = zen_bpf::load(Path::new(&object)).unwrap();
    let mut links = Vec::new();
    for (i, name) in interfaces.0.iter().enumerate() {
        zen_bpf::qdisc_ensure(name).unwrap();
        let ingress = zen_bpf::attach(&mut bpf, "zen_ingress", name, TcAttachType::Ingress).unwrap();
        let egress = zen_bpf::attach(&mut bpf, "zen_egress", name, TcAttachType::Egress).unwrap();
        let fds = (program_fd(&mut bpf, "zen_ingress"), program_fd(&mut bpf, "zen_egress"));
        if i == 0 { links.push((ingress, egress, fds)); }
        else {
            assert_eq!(fds, links[0].2, "Interfaces must reuse loaded programs");
            links.push((ingress, egress, fds));
        }
    }
    for (ingress, egress, _) in links {
        zen_bpf::detach(&mut bpf, "zen_ingress", ingress).unwrap();
        zen_bpf::detach(&mut bpf, "zen_egress", egress).unwrap();
    }
    // Explicit detach must leave the program available for another attachment.
    let link = zen_bpf::attach(&mut bpf, "zen_ingress", &interfaces.0[1], TcAttachType::Ingress).unwrap();
    zen_bpf::detach(&mut bpf, "zen_ingress", link).unwrap();
}
