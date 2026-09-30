# Rust feasibility spike — zen-trafficd（Aya + libubus 直连）

> **状态更新（2026-09-28）**：正式包已按本 README §8 的目标布局落地——
> `../../zen-traffic/`（workspace：zen-ubus-sys / zen-bpf / zen-trafficd，
> 含 SQLite 持久化与 ubus `zen.traffic` 全方法）。本 spike 保留为
> Step 1–5 验证基线，正式包 SDK/真机验收前应先跑通本手册。

> 目的：**只做可行性验证，不实现完整业务**。全部 Step 通过后才开始正式重写
> zen-trafficd（Rust）。现有 C PoC（`poc/src/zen-trafficd-poc.c`，1035 行）
> **保留不动**，作为 Rust 行为对照的 C reference implementation。
>
> 技术路线（已定案）：
>
> ```
> Kernel   zen_traffic.bpf.c（C + clang → .bpf.o，保持现状，很小、稳定）
>              ↓
>          Aya（Rust，加载/attach/map 读，替代 libbpf C API）
>              ↓
>          zen-trafficd（Rust）
>              ↓
>          ubus（libubus 直连，FFI）→ LuCI Zen
> ```
>
> 红线不变：无 HTTP、无 TCP 端口、无 shell rpcd 桥、ubus handler 不经中间层。

## 目录结构

```
rust-spike/
├── Cargo.toml                  # workspace
├── Makefile                    # Step 1：OpenWrt SDK 包（rust-package.mk 模式）
├── crates/zen-ubus-sys/        # Step 4：最小 libubus/libubox/uloop FFI（无 bindgen）
│   ├── build.rs                #   链接：UBUS_LIB_DIR(SDK staging) / 系统默认
│   └── src/lib.rs              #   手工转写布局（来源：openwrt ubus/libubox master 头文件）
├── crates/zen-trafficd-spike/
│   └── src/
│       ├── main.rs             # 编排 + Step 5 信号处理/清理顺序
│       ├── bpf.rs              # Step 2/3：Aya load、对象识别、devices map 读
│       ├── tc.rs               # Step 3：clsact qdisc、ingress/egress attach/detach
│       └── ubusd.rs            # Step 4/5：zen.traffic(ping/stats)、uloop、tick
└── scripts/
    ├── build-bpf.sh            # clang -target bpf 编译 poc/bpf/zen_traffic.bpf.c
    └── verify.sh               # Step 2–5 自动验证（输出 PASS/FAIL）
```

---

## Step 1 — OpenWrt SDK 交叉编译 PASS

把 `poc/rust-spike` 整个目录拷入 SDK（包根 = Cargo workspace 根）：

```sh
# SDK 根目录
cp -a <repo>/poc/rust-spike package/zen-trafficd-spike
./scripts/feeds update base packages
./scripts/feeds install rust libubus libubox
make defconfig
make package/zen-trafficd-spike/{clean,compile} V=s
# 产物：bin/packages/<arch>/utils/zen-trafficd-spike_*.ipk
```

**PASS 判据**：`compile` 无错误退出，ipk 内含 `/usr/bin/zen-trafficd-spike`
（目标架构）。检查架构依赖已按 `RUST_ARCH_DEPENDS` 约束。

已知适配点（遇到再看 §Troubleshooting）：
- `rust-package.mk` 宏名随 SDK 版本有差异（master 为 `RustBinPackage`，
  旧版可能是 `RustPackage` + 自定义 `Build/Compile`）；
- SDK rustc 需 ≥ aya 0.13 的 MSRV（≈1.80）。ImmortalWrt 25.x / 24.10
  packages feed 的 rust 满足；过低时用 `yangxu52/openwrt-rust-backports`。

开发机本机快速编译检查（不走 SDK，需本机 libubus/libubox）：

```sh
cd poc/rust-spike
cargo build --release          # 产物 target/release/zen-trafficd-spike
```

## Step 2 — Aya 加载 zen_traffic.bpf.o PASS

```sh
./scripts/build-bpf.sh                      # 产出 rust-spike/zen_traffic.bpf.o
./target/release/zen-trafficd-spike \
    -b ./zen_traffic.bpf.o -i br-lan
```

**PASS 判据**（日志 `== BPF 对象清单 ==`）：
- `program: zen_ingress (SchedClassifier(tc))` / `zen_egress`；
- `map: devices (HASH)`、`map: local_prefixes (LPM_TRIE)`；
- license=GPL 段由 ELF 自动读取（`bpf_ktime_get_ns` 为 gpl-only，加载即验证）。

失败即说明 Aya/aya-obj 对本对象（BTF-defined maps、无 CO-RE）存在兼容问题——
这是本 spike 最核心的验证点。

## Step 3 — clsact + TC attach/detach + map read PASS

daemon 启动即自动完成（`tc.rs`）：

1. `tc::qdisc_add_clsact(iface)`（已存在 → EEXIST 视为复用，退出时**不删**）；
2. `zen_ingress → attach(iface, TcAttachType::Ingress)`；
3. `zen_egress → attach(iface, TcAttachType::Egress)`；
4. 每 1s tick 遍历 `devices` map（`HashMap::try_from` + `iter()`，差分得速率）；
5. 退出时显式 `detach` 两个 filter + 仅本次创建时 `qdisc_remove_clsact`
   （等价 C 版"只删自己创建的 clsact"）。

**PASS 判据**：

```sh
tc filter show dev br-lan        # in/egress 各 1 条 zen_ingress/zen_egress
# 制造流量（LAN 主机 ping/iperf3 网关外地址）后，daemon 日志出现：
# [tick N] devices=1 WAN↓ x KB/s WAN↑ y B/s | aa:bb:cc:dd:ee:01 wan_rx=...
kill -TERM <pid> 后 tc filter show 无 zen_ 残留
```

注意：`local_prefixes` 在 spike 中**留空**（不灌前缀）——所有非组播流量都计入
`wan_*`。这与 C 版有 `-P` 时不同，是 spike 的有意简化。

## Step 4 — libubus 直连发布 PASS

daemon 与 BPF 部分完全独立：ubus 对象注册失败不影响 Step 2/3 的排查
（也可 `--no-attach` 在开发机单独验证 Step 4/5，无需 root）。

```sh
ubus call zen.traffic ping
# 期望：{ "status": "pong", "daemon": "zen-trafficd-spike", "pid": <pid> }

ubus call zen.traffic stats
# 期望（结构化，最近 tick 快照）：
# { "daemon": ..., "devices": N, "wan_rx_rate": .., "wan_tx_rate": ..,
#   "wan_rx_bytes": .., "wan_tx_bytes": .., "lan_rx_bytes": ..,
#   "lan_tx_bytes": .., "ticks": N }
```

**PASS 判据**：两条调用均返回结构化结果且直接来自 Rust daemon
（日志中 `[spike] ubus 对象已注册`；`layout_report()` 打印
`sock offset = 80`（64 位）确认 FFI 布局自检）。

FFI 说明（`crates/zen-ubus-sys`）：
- **无 bindgen**：布局逐字段手工转写自 openwrt/ubus 与 openwrt/libubox
  master 头文件（libubus.h / blob.h / blobmsg.h / uloop.h / avl.h / list.h）；
- 头文件 static inline（`ubus_add_uloop`、`blobmsg_add_string/u64` 等）在
  Rust 侧等价复现，只依赖导出符号；
- `ubus_context` 仅转写到 `sock` 字段（内联 `ubus_add_uloop` 需要
  `&ctx->sock`，偏移 = 16 + 48 + 16 = 80 @64-bit），其余为不透明尾部。

## Step 5 — 事件循环 + SIGTERM clean shutdown PASS

信号路径：`signal(SIGTERM/SIGINT)` → 置 `SHUTDOWN` + 写 `uloop_cancelled`
→ uloop 退出（1s tick 兜底唤醒，退出延迟 ≤1s）→ 顺序清理：

```
uloop 退出 → 显式 detach 两个 TC filter → qdisc（仅本次创建时删）
           → ubus_free → uloop_done → 退出码 0
```

**PASS 判据**：`kill -TERM <pid>` 后 ≤1s 退出、日志含
`TC filter 已 detach` / `clean shutdown 完成`、`tc filter show` 无残留、
退出码 0。`verify.sh` 已自动化以上全部判据。

---

## 一键验证

```sh
./scripts/verify.sh ./zen_traffic.bpf.o br-lan ./target/release/zen-trafficd-spike
```

## Troubleshooting

| 现象 | 处理 |
|---|---|
| SDK 报 `RustBinPackage` 未定义 | 旧版 rust-package.mk：改用 `$(eval $(call RustPackage,...))` + 参考旧版宏手写 Build/Compile（cargo + RUSTFLAGS） |
| rustc 版本低于 aya MSRV | `rustc --version` 确认；SDK rust 过旧时 backport（yangxu52/openwrt-rust-backports） |
| `cargo: linker` 找不到 | 确认 feeds 已 `install rust`；检查 rust-package.mk 是否导出 TARGET_LINKER |
| 链接错误 `ubus_add_object undefined` | UBUS_LIB_DIR 未生效：Makefile 已导出 `$(STAGING_DIR)/usr/lib`，检查 staging 内有 libubus.so/libubox.so |
| `ubus_connect 失败` | 开发机未跑 ubusd；路由器上默认路径 /var/run/ubus.sock 正常 |
| 加载 .bpf.o 失败（BTF/verifier） | 记录 aya 报错原文——这正是 spike 要暴露的问题；对象本身已被 C/libbpf 验证过 |
| attach 权限错误 | 需要 root / CAP_NET_ADMIN；确认内核 clsact、tc 可用（`tc qdisc show dev br-lan`） |
| 32 位目标 timeval 报错 | lib.rs 已按指针宽度 cfg；如 musl time64 布局仍有出入，从 Step 4 的 layout_report 定位 |

## 验证通过后回答的 8 问（模板）

1. **Rust OpenWrt SDK 编译**：PASS/FAIL（Step 1，附 ipk 架构）
2. **Aya load**：PASS/FAIL（Step 2，附对象清单日志）
3. **TC attach API**：PASS/FAIL（Step 3，附 tc filter show 前后对比）
4. **BPF map read**：PASS/FAIL（Step 3 tick 日志 / stats 输出）
5. **ubus direct publish**：PASS/FAIL（Step 4，ping/stats 原始输出）
6. **libubus FFI unsafe 面**：见下（静态数字，随实现确认）
7. **新增依赖**：见下
8. **正式 daemon 结构**：见下

### 6. FFI unsafe 面统计（当前实现）

- `zen-ubus-sys`：**11 个 extern "C" 函数声明 + 1 个 extern static**
  （blob×4、uloop×5、ubus×4… 实际见 lib.rs），结构体 9 个，无 bindgen；
- 调用侧 unsafe 块集中在 `ubusd.rs`（handler/注册/uloop）与 `main.rs`
  （signal 注册 + uloop_run），全部有 `// Safety` 注释；
- 安全边界：handler 只在 uloop 主线程执行；Bpf 经 `Mutex<Option<Bpf>>`
  共享；blob_buf 每次请求栈上新建。

### 7. 最终新增依赖（workspace）

| crate | 用途 |
|---|---|
| `aya` 0.13（feature: tc） | BPF 加载 / TC attach / map 读取 |
| `libc` 0.2 | signal 常量与注册 |
| `zen-ubus-sys`（本仓库，path） | libubus/libubox FFI |
| 无 tokio/async、无 bindgen、无 pkg-config crate | —— |

### 8. 正式 zen-trafficd 结构（spike 通过后的目标布局）

```
zen-trafficd/（Rust 正式包）
├── crates/
│   ├── zen-bpf/          # Aya 封装：load/pin 恢复/attach 幂等/map 访问
│   ├── zen-ubus-sys/     # 本 spike 的 FFI 原样升级（补 policy 解析、event）
│   └── zen-trafficd/     # 主 daemon
│       └── src/
│           ├── traffic/      # 1s 轮询、差分速率（bpf.rs 演进）
│           ├── device/       # MAC↔IP/hostname/conn 合并（DHCP/ARP/hostapd）
│           ├── accounting/   # 日/月累计、日切/月切（对齐 ARCHITECTURE §8）
│           ├── persistence/  # checkpoint/恢复（/etc + /tmp 双状态文件）
│           └── ubus/         # zen.traffic 全方法（getDevices/getTotal/...）
└── files/{init.d, config, acl.d}
```

C → Rust 行为对照基线：`poc/src/zen-trafficd-poc.c`（不删除，不逐行翻译，
按 Aya API 与上述模块划分重构）。
