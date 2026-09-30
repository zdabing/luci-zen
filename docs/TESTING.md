# 测试

## CI 层（每次 push / PR）

`.github/workflows/ci.yml` 自动执行：

1. `cargo check --workspace`（`zen-traffic/`）
2. eBPF 对象编译：`clang -target bpf` 编译 `zen-traffic/bpf/zen_traffic.bpf.c`
3. `.po` 翻译文件校验：`node tools/check-po.js`

新增检查（需对应 CI 运行成功后才能作为通过证据）：匹配真机版本的 libubox/libubus
头文件 ABI 编译检查、`cargo test --workspace`、两个包的翻译校验、首页历史恢复
回归及 SQLite 保留/聚合回归。SDK 的 `Build/Configure` 也会使用目标 staging
头文件编译 `abi-check.c`；布局不匹配时停止出包。

## SDK 构建层（tag / release）

`build.yml` 在 OpenWrt SDK 内实际编译 `luci-theme-zen`、`zen-traffic` 与 `luci-app-zen-traffic`，
验证包 Makefile、交叉工具链与依赖元数据；产物 `.apk` 上传为 artifacts。

## 真机验收

数据面行为基线 A–H 的完整判据、环境变量与运行方式见
[poc/README.md §5](../poc/README.md)。要点：

| # | 验证 | 判据摘要 |
|---|---|---|
| A | Ethernet IPv4 上/下行 | 方向正确，量级与 iperf3 一致（±10%） |
| B | IPv6 上/下行 | 归并到同一 MAC 条目 |
| C | Wi-Fi 设备 | 计数 ≈ iperf3 实际字节 0.9~1.3 倍，无双计 |
| D | MAC 归因 | 非流量主机条目增量 < 10% |
| E | 局域网对传 | 不计 WAN |
| F | 多设备并发 | 条目独立正确 |
| G | 重启清理/恢复 | `-p` 计数连续，tc filter 无重复累积 |
| H | SW offload 误差 | OFF/ON 各测一次，结论写回 ARCHITECTURE.md |

已知口径与边界（L3 字节口径、软/硬件分载可见性、组播不计数、
eBPF atomics 内核版本要求）见 [poc/README.md §6](../poc/README.md)。

## 主题浏览器验收

- `dev-preview/index.html` 本地预览明暗两套配色与 Dashboard 布局；
- 真机安装后回归：登录页、概览仪表、菜单树、移动端断点、
  `prefers-reduced-motion` 生效、zh-cn 翻译加载（`.lmo` 存在时）。

## 2026-09-30 NanoPi R5C 验收记录

部署来自 [10Wrt 成功构建 #36706276709](https://github.com/zdabing/10Wrt/actions/runs/36706276709)，
配置提交 `431a21c4ae421ce1ace766476ae23e2c30d150b7`，
OpenWrt 提交 `6ad13aa7290135ac6e1778be95d11b3034b9a416`，
Zen 提交 `bc8b68634fe5914ba705ba5bceb047df8cebeb70`。
源码对应关系以发布附件 `10wrt-sources.tsv` 为准；主题文件哈希已与本地源码核对。

| 环境 | 结果 |
| --- | --- |
| 固件 / 内核 | OpenWrt 25.12-SNAPSHOT，rockchip/armv8，6.12.108 |
| 包 | zen-traffic 0.2.0-r2；主题与应用 0.2.0-r1 |
| 拓扑 | LAN bridge；PPPoE WAN；客户端 A 经外部 Wi-Fi AP，客户端 B 为 NAS |
| 采集 | br-lan，1000 ms，22 台设备，300 秒批量落盘 |
| 卸载 | fw4 配置未启用 flow_offloading；ubus 报告 off；未测试 ON 路径 |
| 前缀 | reloadPrefixes 成功，4 条；默认上游识别为 pppoe-wan |

测试发生在正常家庭后台流量下，没有清空计数或数据库。凭据、真实客户端地址、
MAC 与原始日志仅留在忽略目录 `.zcode/`，不放入公开报告。

| 已测项目 | 实测证据 / 结论 |
| --- | --- |
| ubus 接口 | getStatus/getDevices/getTotal/getHistory/getRealtimeHistory 均正常 |
| MAC 筛选 | 有效设备返回自身日用量；不存在的 MAC 返回空历史 |
| 客户端 A 32 MiB HTTP 上/下行 | tx/rx 方向正确；增量误差 +0.307% / +0.494% |
| 客户端 B 64 MiB TCP 上/下行，限 100 Mbps | tx/rx 方向正确；增量误差 +0.215% / +0.155% |
| B 测试时其他 MAC | 最大同方向增量分别为测试载荷的 0.126% / 3.047%，低于 10% 判据 |
| 正常服务重启 | 22 台设备累计、今日、本月计数均 after ≥ before；正常退出 checkpoint 完成 |
| WAN 历史 | pppoe-wan 可查询，约 5 秒采样，包含最近未落盘样本 |
| LuCI 真机 | 中文登录页与首页可用，PPPoE 状态、双轴曲线、设备列表有真实数据 |
| 本地回归 | 5 个实时历史测试、4 个日/月保留测试、首页历史恢复与两个包翻译校验通过 |

设备增量包括 TCP/IP 与测试控制流量，误差按 `(增量 / 应用载荷 - 1)` 计算。
以上为两个客户端分别到路由器的 LAN 测试，没有证明两设备同时传输、LAN 桥接对传、
WAN 转发、IPv6 或卸载开启时的准确性。TCP 上行 iperf 接收报告少一个发送块，
本表以发送端已发送的 64 MiB 为载荷基准。

| 性能 | 实测 |
| --- | --- |
| 正常后台流量，28.59 秒采样 | daemon CPU 0.245% 单核；RSS 3232 KiB |
| NAS TCP 100 Mbps | daemon CPU 0.303% / 0.341% 单核；RSS 3264 KiB |
| 128 B UDP，50 Mbps，15 秒 | 约 48,826 个应用数据报/秒；daemon 0.279% 单核；整机忙碌 23.014%；接收丢包 0.621% |
| UDP 停采集 / 开采集对照各一次 | 整机忙碌 28.835% / 26.080%；丢包 1.067% / 0.512%；没有证据认定 Zen 引起丢包或量化其逐包成本 |
| 查询往返，5 种方法各 20 次 | 中位数 60–65 ms；P95 68–76 ms；包含 SSH、Wi-Fi、ubus 和 JSON 解码 |
| LuCI 使用的 HTTP /ubus 通道，5 种方法各 30 次 | 中位数 4.91–10.64 ms；P95 8.89–13.36 ms；包含鉴权、Wi-Fi、HTTP 与 JSON 解码 |

CPU 由 `/proc/<pid>/stat` 与 `/proc/stat` 差分计算，daemon 百分比按单核计，整机
忙碌按四核总量计。daemon CPU 不包括 eBPF 在内核网络路径中的开销。短样本中的
零 CPU 差分受时钟 tick 精度限制；HTTP 的 146–253 Mbps 是 Wi-Fi/HTTP 路径结果，
不作为路由器吞吐上限。UDP 应用数据报数也不保证等于 TC 看到的 skb 数（GRO/GSO）。

### 可复现基线

安装 Paramiko 后，在可信终端运行（密码交互输入，不写进参数或文件）：

```sh
python tools/router-baseline.py --host ROUTER_IP --output baseline.json
# 追加可控 LAN 已知大小传输和正常服务重启：
python tools/router-baseline.py --host ROUTER_IP --output baseline.json \
  --transfer --client-ip CLIENT_IP --restart
```

SSH 使用 known_hosts；刷机后须核对新主机密钥，再传入
`--host-key-sha256 <已核对的主机公钥 SHA256 hex>`。HTTP 服务临时绑定指定 LAN
地址和随机端口，传输 32 MiB；关闭服务并清理路由器临时 RAM 文件。此工具不重启
路由器、不重置计数、不改防火墙/卸载配置。输出包含客户端信息，不应直接公开上传。

NAS 原有 SSH 关闭；本次经用户确认临时启用并设置 10 分钟自动关闭，测试后端口
已不可连接。尝试隔离容器运行 Rust 单测时 Docker Hub 连接超时，测试未启动。
NAS `/tmp/zen-p0-test.1m31GWSD` 留有本次无凭据的源码副本；SSH 自动关闭导致
未能删除，RAM 临时目录在 NAS 重启后消失。没有安装编译器或启动测试容器。

### P0/P1 剩余证据

- [ ] 新增 Rust 单元测试 CI 成功记录；当前 Windows 没有 Linux Rust/libubus 构建环境。
- [ ] 目标 musl SDK 中编译新增 ABI guard 并出包；现已用匹配版本头文件在 AArch64
  交叉编译通过 C 静态断言，但使用 Android sysroot，不代替目标 musl SDK 验收。
- [ ] 两客户端同时传输、WAN/IPv6 已知大小测试及 LAN 桥接/跨 VLAN 口径。
- [ ] tc filter 无重复挂载证据（固件没有 tc 命令）；仅重启恢复通过不足以替代此项。
- [ ] 重启整机、跨日/月、NTP 跳变、PPPoE 重连、卸载 ON/OFF、存储故障和 7 天真机连续记录。

因此不将 README 的整个 P0/P1 条目勾为完成。先补 P0 环境与数据面证据，再做
P1 长期/兼容验证；目前数据不支持提前进行 per-CPU map 等 P2 优化。
