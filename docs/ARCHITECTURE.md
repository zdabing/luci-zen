# luci-zen 架构方案（v3 — eBPF 后端 + Rust daemon + SQLite 持久化）

> 状态：本文保留架构设计与历史实现记录；当前 R5C 后台 r10 已正式出包、安装并完成定向验收，完整覆盖范围见 README 和 TESTING。
> 定位：**一个自包含的 OpenWrt/ImmortalWrt LuCI 项目**，自带主题、首页 Dashboard、设备实时流量、LuCI RPC/ubus 接口与流量统计后台。`luci-theme-round` 与 `luci-app-bandix` 仅为源码/设计参考，**不是运行时依赖**。
> 变更记录：v3 按用户定案**持久化层直接采用 SQLite**（三表 devices/daily_usage/monthly_usage；RAM 实时态 + 批量 checkpoint，不使用 JSON 作为正式历史存储；getHistory 随持久化一并实现）。v2.1 正式 daemon 由 C 切换为 **Rust + Aya**（eBPF 数据面仍为 C/clang 编译 `.bpf.o`；libubus 直连不变，无 HTTP/无 shell 桥）；v2 移除全部 nftables 采集设计，V1 直接采用 eBPF TC。
> 前置分析保留在本地研究文档中；当前实现与验收状态以根 README 为准。

2026-10-04 增加独立互联网日账本与后台通知线程。流量插件分为实时监控、历史分析、
通知设置；共享速率组件使用 `baseclass`，由两个父页面渲染，避免 LuCI `view` 自动挂载。
新增 `getInternetHistory`、`getNotifications`、`setNotifications`、`testNotification` 原生 ubus
接口，通知设置/预约/发送结果也保存在 SQLite。curl 通过标准输入接收 HTTPS 配置和
消息，不引入 HTTP 服务。统计窗口、密钥保护与跨重启行为见[页面与通知说明](TRAFFIC_PAGES_AND_NOTIFICATIONS.md)。

---

## 1. Round 哪些设计值得借鉴

| 借鉴点 | 说明 | 采纳方式 |
|---|---|---|
| ucode 模板骨架 | `header.ut/footer.ut/sysauth.ut`，`data-theme` 防闪烁内联脚本，`?v=pkgmtime` 缓存失效 | 结构平移重写，代码归属新项目 |
| 菜单/侧栏 JS | `menu-*.js`：菜单树渲染、桌面折叠、移动抽屉；Zen 首页由独立菜单路由加载，菜单不插入页面内容 | 平移重写 |
| dashboard 性能范式 | DOM 一次构建、更新只碰 `textContent`/SVG 属性、曲线滑动窗口、`niceMax` 刻度 | 直接作为本项目渲染规范 |
| 包工程化 | Makefile 安装布局、uci-defaults 注册主题、rpcd ACL、uhttpd `ucode_prefix` 长缓存 handler（含路径穿越防护）、postinst/postrm 缓存清理 | 整体沿用模式 |
| CSS token 化 | `:root`/`[data-theme=dark]` 全量语义变量 | 重构为 Apple-inspired 色板 + motion token |
| **不借鉴** | 每卡片 `backdrop-filter: blur(10px)`（大面积 blur）、无 `prefers-reduced-motion` | 移除/补齐 |

## 2. Bandix 的完整数据链路（技术参考）

```
内核空间:  TC ingress/egress hook（每接口）
           └─ shared_ingress/shared_egress eBPF 程序（模块开关 MODULE_ENABLE_FLAGS）
              ├─ traffic handler → MAC_TRAFFIC HashMap（key=MAC，值=字节数）
              │   └─ SUBNET_INFO map 区分 WAN/LAN 方向 → w_* 与 l_* 计数
              └─ dns handler → DNS_DATA RingBuf；rate limit handler → RATE_LIMITS map
用户空间:  Rust 守护进程
           ├─ 每 1s 轮询 map → 差分得速率；DeviceManager 做 MAC↔IP 关联与在线跟踪
           ├─ RealtimeRingManager(1s, 内存) / LongTermRingManager(1h, 365d, 写 /tmp/bandix-data)
           └─ Web API 127.0.0.1:8686（Release 只绑本地）
LuCI 桥:   /usr/libexec/rpcd/luci.bandix (shell)：ubus→curl→jsonfilter
前端:      rpc.declare('luci.bandix','getStatus')；rx=下载、tx=上传；(w_rx_r+w_tx_r) 降序在线优先
```

对本项目的启示：
- Bandix 在 eBPF 层只用 MAC 归因、用户态聚合 —— 本项目沿用该分层，但按用户要求 eBPF 层更薄（仅 bytes/packets/last_seen）。
- Bandix 长期数据写 `/tmp`（**重启即失**），无今日/月重置语义 —— 本项目持久化（§9）必须完整。
- Bandix 两个间接层（localhost HTTP + shell rpcd 桥）本项目全部去掉：daemon 直接发布 ubus 服务。
- Bandix UI 自述：硬件交换芯片转发的 LAN↔LAN 流量不可见 —— 一切软件采集的物理边界。

## 3. 后端架构（v2.1：用户态 Rust + Aya；eBPF 数据面保持 C）

> v2.1 定案（用户确认）：eBPF data plane = C + clang 编译 `.bpf.o`（保持现状）；
> userspace = **Rust + Aya**；IPC = daemon 直接注册 ubus（不使用 HTTP、不使用
> shell rpcd bridge）。现有 C PoC（`poc/src/zen-trafficd-poc.c`）**保留**为行为
> 对照基线，正式实现不逐行翻译，按 Aya API 简化 load/attach/map 访问。
> Rust 可行性 spike 见 [poc/rust-spike/](../poc/rust-spike/README.md)。

```
LuCI JS  →  ubus / rpcd (LuCI session + ACL)
              │
              ▼
        native zen-trafficd  (C + libbpf + libubus, procd 守护)
              │   ├─ TC ingress/egress attach (netlink: clsact + cls_bpf direct-action)
              │   ├─ 1s 轮询 BPF maps → 差分 → 实时速率
              │   ├─ 日累计 / 月累计 / checkpoint 持久化
              │   ├─ DHCP(/tmp/dhcp.leases, odhcpd) + neighbour(ARP/NDP) + hostapd(assoclist) 合并
              │   └─ local prefixes (BPF LPM map) ← ubus network.interface dump
              ▼
        eBPF: TC ingress/egress per-MAC  ── BPF Maps: devices(HASH, key=MAC)
                                              local_prefixes(LPM_TRIE, v4-mapped 双栈)
```

红线（用户要求）：不建 HTTP server、不开额外 TCP 端口、不用 shell rpcd 桥、不使用 ucode/shell 轮询 BPF map、eBPF 不做速率/统计/设备信息、不要求内核 BTF/CO-RE。

### 数据面语义（已定）

| 项 | 定义 |
|---|---|
| 唯一 key | **MAC**（IPv4/IPv6 同设备合并到同一 MAC 条目） |
| ingress hook（帧自设备进入 LAN 侧） | 设备 **upload**（src MAC = 设备） |
| egress hook（帧发往设备） | 设备 **download**（dst MAC = 设备） |
| WAN vs LAN-local | 包内 IP 地址 ∈ `local_prefixes` LPM map（IPv4 以 v4-mapped 归一化进同一张 v6 trie）→ LAN-local；否则 WAN。**本地互访不计入 Internet 用量** |
| eBPF 职责 | 仅 `bytes / packets / last_seen`（WAN/LAN 两 scope 各自的收发字节、包数、时间戳） |
| 组播/广播 | 直接跳过（mDNS/NDP/DHCP 噪声不计数） |

### 挂载点分析（为什么挂 br-lan 而不是 WAN）

Internet 流量必然经过"LAN L2 ↔ 路由"：
- 上行：设备帧进入 LAN 桥（dst=网关 MAC）→ bridge pass-up → **br-lan TC ingress 触发**（src=设备 MAC）→ 路由。
- 下行：路由后 `dev_queue_xmit(br-lan)` → **br-lan TC egress 触发**（dst=设备 MAC）→ 桥转发到端口。
- LAN↔LAN 纯桥接流量（PC→NAS 经交换芯片/桥端口直转）**不经过 br-lan 钩子**，天然不会污染 WAN 计数；跨 VLAN 的本地路由流量会被看到，但经 local_prefixes 判为 LAN-local，不计 WAN。
- 因此 v1 挂点 = 各 LAN 桥设备（br-lan，多桥多挂）+ 未桥接的 WLAN 段；**不挂 WAN**（WAN 侧 src MAC 是运营商网关，无归因价值；全局总量走 netlink 接口统计）。

## 4. Package 划分（用户已定）

| 包 | 内容 | DEPENDS |
|---|---|---|
| `zen-traffic` | `zen-trafficd`（Rust/Aya，rusqlite bundled）、`zen_traffic.bpf.o`、init.d（procd + bpffs 挂载）、UCI 配置、ubus ACL | `$(RUST_ARCH_DEPENDS) +libubus +libubox +kmod-sched-bpf +kmod-sched-core`（rust-package.mk 模式；rusqlite bundled 经 cc 编译 SQLite，需 target cc） |
| `luci-app-zen-traffic` | LuCI 视图（设备流量页 devices.js + 历史曲线页 history.js）、menu.d、ACL、依赖 daemon | `+zen-traffic +luci-base` |
| `luci-theme-zen` | 主题 + dashboard（系统/网络/全局流量，真实 ubus 系统数据）+ dashboard 内嵌设备模块（能力探测启用） | `+luci-base`（**不依赖流量组件**） |

一个 Git 仓库三个包；`luci-app-zen-traffic 依赖 zen-traffic`；`luci-theme-zen 独立`。

## 5. 文件目录树

```
luci-zen/
├── poc/                                    # ★ Phase 0 eBPF PoC（当前阶段）
│   ├── bpf/zen_traffic.bpf.c               # TC ingress/egress 程序（MAC key + local prefixes）
│   ├── src/zen-trafficd-poc.c              # PoC 守护进程（libbpf 加载 + netlink attach + ubus）
│   ├── Makefile
│   ├── README.md                           # 构建/运行/A–H 验收手册
│   └── test/run-tests.sh                   # A–H 逐项验收脚本（路由器上执行）
├── zen-traffic/                            # Phase 2 正式包（Rust）
│   ├── Makefile                            # rust-package.mk + bpf.mk（CompileBPF）
│   ├── Cargo.toml                          # workspace：zen-ubus-sys / zen-bpf / zen-trafficd
│   ├── bpf/zen_traffic.bpf.c               # 数据面（与 poc/bpf 同源，A–H 基线）
│   ├── crates/zen-ubus-sys/                # libubus/libubox FFI（spike 基线升级：blob 布局解析 + 客户端 invoke）
│   ├── crates/zen-bpf/                     # Aya 封装：load/attach/map 读/LPM 写
│   ├── crates/zen-trafficd/src/            # main/daemon/state/netlink/netif/device/totals/accounting/persistence/ubus
│   ├── files/etc/init.d/zen-traffic        # procd + bpffs + UCI→CLI
│   ├── files/etc/config/zen-traffic
│   └── files/usr/share/rpcd/acl.d/zen-traffic.json
├── luci-app-zen-traffic/
│   ├── Makefile
│   ├── htdocs/luci-static/resources/view/zen-traffic/devices.js   # 设备流量页
│   ├── htdocs/luci-static/resources/view/zen-traffic/history.js   # 历史曲线页（getHistory）
│   ├── root/usr/share/luci/menu.d/luci-app-zen-traffic.json
│   ├── root/usr/share/rpcd/acl.d/luci-app-zen-traffic.json
│   └── root/etc/uci-defaults/40_luci-app-zen-traffic
├── luci-theme-zen/
│   ├── Makefile
│   ├── htdocs/luci-static/zen/{cascade.css,mobile.css,custom.css,logo.svg}
│   ├── htdocs/luci-static/resources/menu-zen.js
│   ├── htdocs/luci-static/resources/view/zen/{dashboard.js,zen-devices.js,zen-icons.js,zen-format.js,sysauth.js}
│   ├── ucode/template/themes/zen/{header.ut,footer.ut,sysauth.ut}
│   ├── root/etc/uci-defaults/30_luci-theme-zen
│   ├── root/usr/share/rpcd/acl.d/luci-theme-zen.json
│   ├── root/usr/share/ucode/luci-zen/zen-cache.uc
│   └── po/zh_Hans/theme.po
└── docs/{ARCHITECTURE.md, PHASE1-ANALYSIS.md}
```

## 6. ubus API 设计

对象 `zen.traffic`（daemon `libubus` 直接发布；经 rpcd/uhttpd 通道给 LuCI，复用 LuCI session 与 ACL；无任何 TCP 端口）：

| 方法 | 参数 | 返回 | ACL |
|---|---|---|---|
| `getStatus` | – | `{backend:"ebpf", offload:"off"\|"sw"\|"hw"\|"unknown", since, version}` | read |
| `getDevices` | – | `{t, dev:[{mac, ip4, ip6, host, conn:"wifi"\|"wired"\|"router", band, uplink, online, last, rx_r, tx_r, rx_today, tx_today, rx_month, tx_month, rx_total, tx_total}]}` | read |
| `getTotal` | – | `{rx_r, tx_r, rx_total, tx_total, rx_today, tx_today, rx_month, tx_month}`（netlink 接口级） | read |
| `getHistory` | `{mac?, start_ms?, end_ms?, agg:"day"\|"month"}` | `{agg, start, days:[{date, download, upload}]}` 或 `{agg:"month", start, months:[{month, download, upload}]}`（SQLite 聚合；mac 缺省 = 全设备 SUM；默认范围 90 天 / 12 月） | read |
| `setHostname` | `{mac, host}` | `{ok:1}` | write |
| `resetDevice` | `{mac}` | `{ok:1}` | write |

字段方向约定延续 Bandix：**rx=下载、tx=上传**；速率 B/s、累计字节。前端 `rpc.declare + poll` 1~2s。

## 7. eBPF 数据面设计（V1）

### 7.1 Maps

| Map | 类型 | key | value | 用途 |
|---|---|---|---|---|
| `devices` | HASH（≤4096） | `__u8[6]` MAC | `struct dev_stats` | 每设备计数器 |
| `local_prefixes` | LPM_TRIE（≤256，`BPF_F_NO_PREALLOC`） | `{u32 prefixlen; u8 data[16]}` | `u8` | 本地前缀（IPv4 以 `::ffff:a.b.c.d` 归一化，prefixlen=96+n；IPv6 原生；单 map 双栈） |

```c
struct dev_stats {            /* eBPF 层只管 bytes/packets/last_seen */
    __u64 last_seen;          /* bpf_ktime_get_ns() */
    __u64 wan_rx_b, wan_rx_p; /* 下载（egress→设备） Internet  */
    __u64 wan_tx_b, wan_tx_p; /* 上传（ingress←设备） Internet  */
    __u64 lan_rx_b, lan_rx_p; /* 下载（LAN-local）              */
    __u64 lan_tx_b, lan_tx_p; /* 上传（LAN-local）              */
};
```

### 7.2 TC 程序要点

- 两个程序 `zen_ingress` / `zen_egress`（`SEC("tc")`），同一份 `account()` 内联逻辑，稳定 UAPI 头（`ethhdr/iphdr/ipv6hdr/vlan_hdr`），**无 CO-RE、无 kfunc、不依赖目标内核 BTF**；对象内 BTF 仅用于 BTF-defined maps（本地 BTF 随 .o 提供，与内核 BTF 无关）。
- 解析：eth → 802.1Q/QinQ → IPv4/IPv6；计数 `skb->len`（L3 字节，含 GSO 聚合长度）；跳过 IPv4 224/4 与 255.255.255.255、IPv6 ff00::/8、组播/广播 MAC（I/G 位）、ARP/非 IP。
- 计数器更新用 `__sync_fetch_and_add`（内核 ≥5.2 原子加；如遇个别 32 位目标 JIT 不支持，Phase B 提供 spin_lock 变体）。
- 挂载：netlink 原生实现——`clsact` qdisc + `cls_bpf` filter（`TCA_BPF_FD` + `TCA_BPF_FLAG_ACT_DIRECT`），固定 pref/handle 幂等 REPLACE；verdict 恒 `TC_ACT_OK`（旁路观测，不过滤）。
- 持久化/恢复（v3 Rust 版）：**maps 不 pin**——BPF 计数随 daemon 重启清零，累计（今日/月/总量）由 SQLite checkpoint 恢复（崩溃丢失去 checkpoint 止，正常 SIGTERM 无损失）；attach 幂等由 **netlink 按名清理残留 filter**（zen_ingress/zen_egress）+ Aya Link 语义保证（等价 C 版固定 pref/handle REPLACE）。

### 7.3 zen-trafficd（Rust + Aya + libubus FFI，v3 实现）

- crate 划分：`zen-ubus-sys`（FFI，spike 基线升级）→ `zen-bpf`（load/attach/map/LPM）→ `zen-trafficd`（main/daemon/state/netlink/netif/device/totals/accounting/persistence/ubus）。
- 主循环：uloop timer（默认 1s，UCI `interval`）→ 全量遍历 `devices` map → 与上次快照差分 → 速率；累计今日/本月（§8）。
- 属性合并（5s 低频）：DHCP `/tmp/dhcp.leases`（v4 hostname/IP）；odhcpd `/tmp/odhcpd.leases`（DUID-LL/LLT 尽力还原 MAC）；netlink neigh（ARP/NDP，MAC↔IP）；hostapd ubus `get_clients`（conn=wifi + freq→频段）；本机接口 MAC → router；优先级 user > dhcp、租约 > neighbour、router > wifi > wired。
- local prefixes：defaults（`169.254/16`、`fe80::/10`）+ UCI `extra_prefix` + ubus `network.interface dump` 子网（**排除默认路由上游接口**）；netifd 变更经 init.d raw trigger reload / ubus `reloadPrefixes` 重学习。
- 全局速率（getTotal）：netlink `RTM_GETROUTE` 默认路由上游接口 stats64 差分（60s 重探测）。
- 服务发布：`ubus_connect()` + `ubus_add_object()`（`zen.traffic`）+ `ubus_add_uloop()`；ubus 不可用时采集继续（spike 同款语义）。
- 生命周期：procd respawn；SIGTERM → checkpoint → drop(Bpf) 自动 detach → 仅本次创建的 clsact 删除 → 退出。
- 启动：SQLite 恢复（设备属性/用户名/生命周期累计 + 今日/当月接续）→ 残留 filter 清理 → attach → 前缀学习。

## 8. Daily/Monthly 数据存储设计（v3：SQLite）

| 问题 | 设计 |
|---|---|
| 引擎 | **SQLite（rusqlite bundled）**，用户定案：getHistory/历史曲线是正式需求，直接定 SQLite 为持久化后端，避免 Phase 4 从 JSON 迁移；不引入秒级/分钟级原始数据 |
| 库文件 | `/etc/zen-traffic/traffic.db`（UCI `db_path` 可改）；WAL + synchronous=NORMAL |
| 三张表 | `devices(mac PK, hostname, hostname_src, last_ipv4, last_ipv6, first_seen, last_seen, rx_total, tx_total)`；`daily_usage(mac, date, download_bytes, upload_bytes, PK(mac,date))`；`monthly_usage(mac, month, download_bytes, upload_bytes, PK(mac,month))` |
| 实时态 | **只在 RAM**（速率、今日/月累计差分）；严禁每秒写库 |
| 落盘时机 | 每 `checkpoint_secs`（默认 300s）单事务批量 upsert（**绝对值语义**，崩溃重放安全）+ 跨天/跨月立即写 + SIGTERM 立即写 |
| Flash 写入 | ≈12 次/h、单事务提交 —— 无寿命风险 |
| 日/月切换 | 本地午夜/月初；NTP 未同步（系统时间 < 2024）不切、不落带日期数据；切换顺序 = 旧区间落盘 → 保留期清理 → RAM 清零 |
| 保留期 | daily 90 天、monthly 12 个月（日切/月切时 DELETE） |

日/月切换先冻结旧区间绝对值，再接续新日期/月；已关闭区间与全部 RAM 设备
在后续 checkpoint 的同一事务中保存，成功后才清空待提交快照。活动超时只影响
展示，不能据此丢弃未保存用量。旧区间快照按相同保留窗口淘汰，设备重置同步清除
其待提交项。快照仍在 RAM，存储故障期间进程崩溃或断电的恢复保障需另行验收。
| 重启恢复 | devices 表恢复属性 + 生命周期累计 + 用户指定名；daily/monthly 当期行接续今日/月累计；BPF map 从 0 重采（不 pin，见 §7.2），DB 基线 + 差分合成 |
| 离线设备 | 保留计数与 `last_seen`；在线 = `last_active + offline_timeout(默认600s)`；>7 天离线退出 RAM（休眠，DB 保留） |
| 历史曲线 | `getHistory` 直接查 SQLite 聚合（SUM GROUP BY），无中间 JSON 层 |

## 9. 性能风险与对策

| 风险 | 量级/对策 |
|---|---|
| TC 每包成本 | 两个 hook 仅做头解析 + 一次 hash lookup + 原子加；千兆线速下可忽略（Bandix 同层验证过）；无 per-packet 用户态交互 |
| 1s map 全量读 | HASH ≤100 实际设备，`bpf_map_get_next_key+lookup` 微秒级，无 fork/无 shell |
| ubus 响应 | 100 设备 ≈30KB/次 @1~2s，可接受 |
| 前端 | MAC 缓存行节点 + textContent-only 更新 + appendChild 重排 + `document.hidden` 暂停（规范，UI 阶段执行） |
| daemon 内存 | 每设备 ~1KB → 100 台 <1MB |

## 10. Flow Offloading 的影响

| 模式 | 影响 | 对策 |
|---|---|---|
| 关闭（OpenWrt 默认） | 无影响 | – |
| **软件分载** | 挂点在 LAN L2（br-lan in/egress），位于 fastpath 判定的上游/下游关系**待 Phase 0-H 实测定量**：分析预期下行（egress br-lan→xmit）仍被计数；上行视 fw4 flowtable 是否把 LAN 设备列入 flowtable devices 而定 | H 项给出实测误差；必要时文档化"关闭软分载或接受误差"；不在用户侧自动改配置 |
| **硬件分载** | 包不过 CPU，软件不可见（Bandix 同样受限） | **UI 明示统计可能不准确，不自动修改用户设置**（用户定案）；daemon `getStatus` 上报 offload 状态供 UI 徽标 |

## 11. OpenWrt 版本兼容性

| 项 | 说明 |
|---|---|
| 目标 | OpenWrt 24.10（kernel 6.6）、ImmortalWrt 25.x（6.6/6.12） |
| 内核要求 | `CONFIG_BPF_SYSCALL`、`cls_bpf`（kmod-sched-bpf）、`clsact`（kmod-sched-core）、BPF atomics（≥5.2 即满足）；**不要求 `CONFIG_DEBUG_INFO_BTF`**（无 CO-RE，本地 BTF 随对象加载） |
| 架构 | x86_64/aarch64/arm 优先；个别 32 位 MIPS JIT 若不支持 eBPF atomics → spin_lock 变体（Phase B） |
| 用户态 | libbpf/libelf/zlib/libubus/libubox 均为标准包 |

## 12. Phase 0 — eBPF PoC（当前工作，UI 未开始）

目标：在真实路由器上证明数据面正确，全绿后才进入 LuCI Theme。

| # | 验证项 | 判据 |
|---|---|---|
| A | Ethernet IPv4 下/上行正确 | iperf3 (v4) 方向不颠倒，速率量级匹配（L2/L3 计数口径差 ±10% 内） |
| B | IPv6 下/上行正确 | iperf3 -6 归因到同一 MAC，方向正确 |
| C | Wi-Fi 设备正确 | 无线客户端速率/方向正确，且**无双计**（只挂 br-lan，不挂端口） |
| D | MAC 归因正确 | 两台主机并发，各 MAC 条目互不串数 |
| E | PC→NAS 局域网传输不计 WAN | LAN↔LAN iperf3：双方 wan_* 增量 ≈ 0（lan_* 或不可见） |
| F | 多设备并发正确 | 双 iperf3 流并行，各自速率独立正确 |
| G | daemon 重启清理/恢复 | 重启后 filter 不重复（tc 计数恒 2）、pin 模式计数连续、非 pin 模式干净重建 |
| H | SW Flow Offloading ON/OFF 误差 | 软分载开/关各跑 A，量化误差并记录结论（硬件分载仅文档化） |

PoC 代码：`poc/`（eBPF 程序 + native 守护进程 + 验收脚本），构建与执行手册见 `poc/README.md`。

## 13. 开发阶段划分

| 阶段 | 内容 | 完成标志 |
|---|---|---|
| **0 eBPF PoC** | 本阶段：poc/ 数据面 + native daemon 骨架 + A–H 验收 | 路由器上 8 项全 PASS（记录实测数据） |
| 1 LuCI Theme | luci-theme-zen 全套（token 重构、dashboard 系统卡/网络卡/全局流量，真实 ubus 系统数据） | SDK 编译出 ipk、真机可用 |
| 2 zen-traffic 正式包 | PoC → 正式 daemon（持久化/日切/属性合并/getDevices/getTotal）+ init.d/UCI/ACL | 真机设备列表为真实数据 |
| 3 luci-app-zen-traffic | 设备流量页 + dashboard 内嵌模块（Top-N/展开/图标/1~2s 更新/降级） | UI 全功能 |
| 4 持久化与历史 | getHistory（今日/月曲线）、重启恢复验证 | 跨日/跨月/重启不丢 |
| 5 响应式与视觉 | 移动断点/dark mode/reduced-motion | 375px~1440px 双模式走查 |
| 6 性能 | 10/20/50/100 台压测、hidden 节流 | 100 台前端 tick <15ms |
| 7 编译与真机 | SDK 24.10 + ImmortalWrt 25 双编译、浏览器验收、offload 三态回归 | 发布 ipk + 安装文档 |

每阶段交付：修改文件清单 + 功能点 + 测试结果（追加至本文档末尾执行记录）。

---

## 执行记录

### Phase 0（代码就绪，待真机验收）

**交付文件**
- `poc/bpf/zen_traffic.bpf.c` — TC ingress/egress 数据面：MAC 唯一 key；IPv4/IPv6 归并同条目；`devices` HASH + `local_prefixes` LPM（v4-mapped 单表双栈）；只计 bytes/packets/last_seen；组播/广播/ARP 跳过；分片非首包仍计数；无 CO-RE、无 kfunc、不依赖目标内核 BTF；verdict 恒 `TC_ACT_OK`。
- `poc/src/zen-trafficd-poc.c` — native daemon（C + libbpf + libubus + 原生 netlink）：clsact/cls_bpf(direct-action) 幂等 attach（固定 pref/handle + REPLACE）、1s uloop timer 差分速率、maps pin 复用与清理、local prefixes（defaults + ubus `network.interface dump` 且**排除默认路由上游接口** + CLI `-P`）、ubus 对象 `zen.traffic.poc`（getStats/reset/reloadPrefixes）。无 HTTP、无 TCP 端口、无 shell 轮询。
- `poc/Makefile` — 开发机 / OpenWrt SDK 双模式构建。
- `poc/test/run-tests.sh` — A–H 验收脚本（jsonfilter 解析 ubus，iperf3 场景编排，SW offload 自动开/还原）。
- `poc/README.md` — 构建部署手册 + A–H 判据 + 口径说明（L3 字节 ±10%、分片、atomics 内核 ≥5.2 与 spin_lock 备选）。

**功能自检（静态）**：daemon 32 个函数引用一致性通过；PoC 全部文件无 nftables 残留；方向语义 = 用户定案（ingress=上传 / egress=下载）。

**待真机执行**（阻塞后续 UI 阶段）：`poc/README.md` §5 的 A–H 八项，全部 PASS 后把实测数据回填本节，进入 Phase 1（LuCI Theme）。

### v2.1 — Rust 切换决策 + feasibility spike（代码就绪，待验证）

**决策**（用户确认）：正式 daemon 由 C 切换为 **Rust + Aya**；eBPF 数据面保持
C/clang 编译 `.bpf.o`；libubus 直连（无 HTTP/无 shell 桥）不变。理由：业务复杂度
集中在 daemon（设备管理/速率/日月统计/持久化/JSON），Rust 维护性显著优于大块 C；
eBPF C 侧保持极小稳定。已知唯一摩擦点为 libubus 无成熟 Rust 绑定 → 自建最小 FFI。

**交付文件**（`poc/rust-spike/`，不重写 C PoC、不实现完整业务）：
- `crates/zen-ubus-sys/` — 最小 libubus/libubox/uloop FFI：**无 bindgen**，布局逐字段
  手工转写自 openwrt/ubus 与 openwrt/libubox master 头文件；`ubus_add_uloop` 等头文件
  inline 在 Rust 侧等价复现；`ubus_context` 仅精确转写至 `sock` 字段（64 位偏移 80），
  附运行时 layout_report 自检。
- `crates/zen-trafficd-spike/` — Step 2/3：BpfLoader 加载 `zen_traffic.bpf.o`、识别
  SchedClassifier（zen_ingress/zen_egress）与 devices(HASH)/local_prefixes(LPM_TRIE)、
  clsact qdisc、TC ingress/egress attach/detach（仅本次创建时删 qdisc，对齐 C 版语义）、
  1s tick 遍历 devices map 差分速率；Step 4：ubus 对象 `zen.traffic`（ping/stats）
  直接发布；Step 5：uloop + SIGTERM clean shutdown（detach → qdisc → ubus_free →
  uloop_done）。
- `Makefile` — Step 1：OpenWrt SDK 包（官方 `rust-package.mk`/`RustBinPackage` +
  `RUST_ARCH_DEPENDS` + `+libubus +libubox`）。
- `scripts/{build-bpf.sh, verify.sh}` — .bpf.o 编译 + Step 2–5 自动验证。

**依赖新增**：aya 0.13（feature tc）、libc、zen-ubus-sys（仓库内）；无 tokio/bindgen。

**待执行验证**（8 问清单见 rust-spike/README.md）：① SDK 交叉编译 PASS；② Aya
load PASS；③ TC attach 完成；④ devices map 读 PASS；⑤ `ubus call zen.traffic
ping/stats` 直连 PASS；⑥ FFI unsafe 面统计；⑦ 依赖清单确认；⑧ 正式 daemon 结构
（traffic/device/accounting/persistence/ubus 模块划分）定稿。全部通过后才开始正式
重写 zen-trafficd（Rust），C PoC 保留为对照基线。

### v3 — Phase 2 + Phase 3 交付（zen-traffic + luci-app-zen-traffic，代码就绪，待 SDK/真机验收）

**定案**（用户确认）：① 范围 = zen-traffic 后台包 + luci-app-zen-traffic 一次交付；
② 持久化直接 SQLite（三表 devices/daily_usage/monthly_usage，RAM 实时态 + 批量
checkpoint，不使用 JSON 历史层，getHistory 本次实现）；③ 设备属性全量合并
（DHCP + neighbour + hostapd）；④ `luci-theme-zen` 保持零硬依赖（运行时能力探测）。

**交付文件**
- `zen-traffic/Cargo.toml` + `crates/` — workspace：`zen-ubus-sys`（spike FFI 升级：
  blob_attr 真实布局——id_len 大端、EXTENDED 位、blobmsg_hdr{be16 namelen,name[]} 2 字节
  对齐头，经 libubox master 头文件核实；blobmsg 解析辅助；ubus_lookup/lookup_id/invoke
  客户端侧）→ `zen-bpf`（Aya load/attach/detach、devices map 全量读、LPM 前缀写入）→
  `zen-trafficd`（main/daemon/state/netlink/netif/device/totals/accounting/persistence/ubus）。
- `zen-trafficd` 核心行为：1s 差分（计数重置保护）；SQLite checkpoint（300s 批量事务 +
  日切/月切 + SIGTERM；绝对值 upsert；90d/12m 保留；NTP 未同步不切）；日/月累计跨重启
  接续；netlink（links stats64 / 默认路由上游 / ARP+NDP / **按名清理残留 TC filter**）；
  属性合并（dhcp.leases + odhcpd DUID 还原 + hostapd get_clients + 本机 MAC=router）；
  getTotal 上游接口差分；ubus `zen.traffic` 7 方法（getStatus/getDevices/getTotal/
  getHistory/setHostname/resetDevice/reloadPrefixes）；ubus 不可用采集继续。
- `zen-traffic/Makefile` — RustBinPackage + bpf.mk `CompileBPF`（Build/Configure 产出
  `.bpf.o`）；`files/` — procd init.d（bpffs 自动挂载、UCI→CLI、respawn、netifd raw
  trigger）、UCI 配置、rpcd ACL。
- `luci-app-zen-traffic/` — devices.js（Top-N 表、行展开、hostname 编辑、单设备重置、
  2s 轮询、hidden 节流、daemon 缺失降级卡、样式自包含不依赖主题）+ history.js
  （日/月切换、设备选择、SVG 折线）+ menu.d/ACL/uci-defaults/Makefile（DEPENDS
  `+zen-traffic +luci-base`）。
- `luci-theme-zen/zen-devices.js` — dashboard 内嵌模块升级为真实设备列表（Top-N 8 行
  折叠/展开、图标归因、今日/月累计、2s 轮询）；probe() 降级语义不变；Makefile 依赖
  未动（仍仅 `+luci-base`）；`cascade.css` 补 `.zen-dash-dev-more`。
- `zen-traffic/bpf/zen_traffic.bpf.c` — 自 poc/bpf 平移（数据面不改语义）。

**静态自检**：libubox blob/blobmsg 布局经官方头文件逐条核实（id_len BE、namelen BE、
BLOBMSG_ALIGN=2、BLOB_ATTR_LEN_MASK 未含对齐）；init.d `sh -n`、3 个 JSON、Cargo
清单通过；Rust 侧因本机无 cargo/libubus/SDK 未编译（已知风险点见下）。

**已知风险点（SDK/真机验收清单）**：
1. aya 0.13 API 面（`qdisc_add_clsact/remove_clsact`、`HashMap::try_from/iter/insert`、
   `LpmTrieKey` 构造）以 spike 验证过的调用为准，`LpmTrie::insert` 参数顺序待编译确认；
2. rust-package.mk 各 SDK 版本宏差异（spike README §Troubleshooting 同款）；rusqlite
   bundled 需要 target cc（`cc` crate 经 SDK 环境变量）；
3. `CompileBPF` 产物路径为 `<src>.o`（bpf.mk llvm 全管线），与 bpf-headers 的 UAPI
   匹配需在 SDK 内验证；
4. spike Step 1–5 真机验证未执行——正式 daemon 验收前先跑 spike 8 问；
5. A–H 行为对照：PoC 验收脚本数据源为 `zen.traffic.poc getStats`，正式 daemon 用
   `zen.traffic getDevices`，验收时需相应调整（或临时跑 PoC 对照）。

**待真机执行**：SDK 24.10 + ImmortalWrt 25 双编译 → spike 8 问 → init.d 启动/respawn →
`ubus call zen.traffic getStatus/getDevices/getTotal` → A–H 行为对照 → SQLite 跨日/
跨月/重启恢复 → luci-app 页面与 dashboard 模块浏览器验收。
