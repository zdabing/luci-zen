//! Step 3：clsact qdisc + TC ingress/egress attach / detach。
//!
//! 与 C PoC（zen-trafficd-poc.c netlink cls_bpf direct-action）的语义对照：
//!   - C 版固定 pref 1 handle 1 REPLACE 幂等挂载；Aya 走自管 link 语义，
//!     attach 产生 filter，Link drop / Bpf drop 时自动 detach；
//!   - verdict 恒 TC_ACT_OK（数据面程序自身保证），Aya 侧不做任何 verdict 干预；
//!   - 清理策略：退出时 drop(Bpf) 自动 detach 两个 filter；qdisc 仅在
//!     本进程创建时才删除（与 C 版"只删自己创建的 clsact"一致）。

use aya::programs::tc::{self, TcAttachType};
use aya::programs::SchedClassifier;
use aya::Bpf;

/// 确保 clsact 存在；返回是否为本进程新建（决定退出时是否删除）。
pub fn qdisc_ensure(iface: &str) -> Result<bool, String> {
    match tc::qdisc_add_clsact(iface) {
        Ok(()) => Ok(true),
        Err(e) if e.raw_os_error() == Some(libc::EEXIST) => Ok(false),
        Err(e) => Err(format!("{iface}: 创建 clsact 失败: {e}")),
    }
}

/// 挂载单个 TC 程序（name = .bpf.o 内的 ELF 符号名）。
/// 返回 LinkId 仅用于显式 detach（Link 存活期间 filter 有效）。
pub fn attach(
    bpf: &mut Bpf,
    prog_name: &str,
    iface: &str,
    ty: TcAttachType,
) -> Result<aya::programs::links::TcLinkId, String> {
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

/// 显式 detach（Step 3 验收点；drop(Bpf) 亦会自动完成同一动作）。
pub fn detach(
    bpf: &mut Bpf,
    prog_name: &str,
    link: aya::programs::links::TcLinkId,
) -> Result<(), String> {
    let prog: &mut SchedClassifier = bpf
        .program_mut(prog_name)
        .ok_or_else(|| format!("program {prog_name} 未找到"))?
        .try_into()
        .map_err(|_| format!("program {prog_name} 不是 SchedClassifier"))?;
    prog.detach(link)
        .map_err(|e| format!("{prog_name} detach 失败: {e}"))
}

/// 退出清理：仅当 clsact 为本进程创建时删除。
pub fn qdisc_cleanup(iface: &str, created_by_us: bool) {
    if created_by_us {
        if let Err(e) = tc::qdisc_remove_clsact(iface) {
            eprintln!("[spike] {iface}: 移除 clsact 失败: {e}");
        } else {
            println!("[spike] {iface}: clsact 已移除");
        }
    }
}
