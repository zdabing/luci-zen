# LuCI Zen

面向 OpenWrt / ImmortalWrt 的 LuCI 主题与流量统计项目：统一登录页、仪表盘和设备列表，提供设备日/月用量与 WAN 实时历史查询。

界面参考 Obsidian 的黑白层次与 apple-design 的交互细节；上传为橙色、下载为绿色、在线状态为绿色。后台使用 **Rust + Aya + TC eBPF + 原生 ubus + SQLite**，不依赖 Bandix，不额外启动 HTTP 服务。

> **当前状态（2026-10-01）：功能代码已实现，仍在持续验收。**
> 下方“已完成”表示仓库中已有实现，“待完成”包含验收与尚未实现的功能。已验证部署固件的性能、计数和自然跨日/月；新增构建检查尚未重新出包安装，部署时请核对安装包对应的提交。

## 版本与更新

当前源码版本：**0.2.0**（2026-09-30），对应标签 `v0.2.0`。三个 OpenWrt 包和 Rust daemon 统一使用此版本。

本版新增 7 天 WAN 实时历史查询，修复 ubus 前缀/MAC 解析与日/月清理，完善设备排序、上传/下载双轴图表和中文翻译，并补齐 OpenWrt 集成文档。完整记录见 [CHANGELOG.md](CHANGELOG.md)。

安装包以 [GitHub Actions](https://github.com/zdabing/luci-zen/actions/workflows/build.yml) 成功构建并发布到 [Releases](https://github.com/zdabing/luci-zen/releases) 为准；源码版本号不代表构建或真机验收已经通过。

## 阅读导航

- [安装包与依赖](#三个安装包)
- [已完成的功能](#已完成代码实现)
- [待完成与验收顺序](#还需要做)
- [统计口径与限制](#统计口径与限制)
- [集成到 OpenWrt：固件内置、SDK 出包、路由器安装](#集成到-openwrt)
- [采集接口与数据库配置](#采集与存储配置)
- [验收和故障排查](#检查和排查)
- [开发检查与发布](#开发检查和发布)

## 三个安装包

| 包 / 源码目录 | 作用 | 依赖与架构 |
| --- | --- | --- |
| `luci-theme-zen` | 登录页、浅色/深色主题、首页仪表盘 | `luci-base`；架构 `all` |
| `zen-traffic` | eBPF 采集、Rust daemon、ubus、SQLite | 按目标架构编译；依赖 libubus、libubox、TC/BPF 内核模块等 |
| `luci-app-zen-traffic` | 设备管理、日/月历史、实时历史查询 | `zen-traffic`、`luci-base`；架构 `all` |

可以只安装主题，首页通过 `zen.traffic` 能力探测启用设备统计。流量应用必须配套安装后台，也可以在其他 LuCI 主题下使用。

## 已完成（代码实现）

以下勾选表示功能已落入正式源码，适配范围和真机验证仍以待办清单为准。

### 主题、首页与设备界面

- [x] 登录页、侧栏、明暗模式、响应式布局与减少动态效果适配。
- [x] 系统信息、运行时间、启动时间、负载、CPU、内存、存储展示。
- [x] 网络接口、协议、地址、连接状态；WAN 优先选择。
- [x] 实时上传/下载、接口累计发送/接收。
- [x] 首页与实时历史查询页双 Y 轴：左轴橙色上传，右轴绿色下载，各自缩放。
- [x] 首页图表悬停显示时间与真实速率；刷新恢复 WAN 最近 5 分钟历史。
- [x] 设备类型图标、在线状态、IP、MAC、连接方式和最后活动时间。
- [x] 首页实时上传/下载独立列及排序，上传在前。
- [x] 默认按实时上传＋下载合计降序，相同时按今日用量合计降序。
- [x] 首页默认展示前 8 台，居中的“显示全部”按钮；目前首页最多渲染前 50 台。
- [x] 点击/键盘展开详情，展示今日、本月、累计用量与每日历史。
- [x] 单日/月数据用柱状图，多日/月数据保留曲线；只读历史页去掉保存/复位按钮。
- [x] 复用设备行和图标，顺序变化时才移动行，减少轮询重排。
- [x] 自有页面中文翻译随包生成 `.lmo`；翻译工具或转换失败时构建报错。

### 采集、存储与查询

- [x] TC ingress/egress 按 MAC 统计 IPv4/IPv6 流量，可配置多个采集接口。
- [x] 自动学习本地前缀，区分 LAN-local/WAN；eBPF 只统计，返回 `TC_ACT_OK`。
- [x] DHCP、邻居表和 hostapd 信息合并；异步查询并缓存 Wi-Fi 客户端。
- [x] daemon 原生 ubus 查询、设备名称覆盖、设备统计重置。
- [x] SQLite 设备累计、每日和每月记录，内存累计后批量写盘。
- [x] 日/月清理分别执行，避免一种历史的清理误删另一种历史。
- [x] WAN 实时速率每 5 秒采样、每 5 分钟批量落盘、保留 7 天。
- [x] 实时历史支持接口、5 分钟/1 小时/24 小时/7 天/自定义区间和分页数据表。
- [x] 查询包含未落盘样本，长区间按平均速率聚合并限制返回点数。
- [x] 网络接口事件刷新前缀/上游，不重启 daemon；修改服务配置仍需重启。
- [x] 修复 ubus 普通容器与 4 字节名字头解析，覆盖前缀学习和按 MAC 查询。

## 还需要做

建议先完成 P0，再做 P1；P2 按实际需求安排。下面的未勾选项不表示已有功能不可运行，表示仍缺少验收证据或实现。

2026-09-30 至 10-01 已在 NanoPi R5C 完成部署核对、两个 LAN 客户端分别及并发方向/独立计数、服务重启
和性能基线：正常后台流量下 daemon 约 0.25% 单核 CPU、3.16 MiB RSS，TCP 用量误差
单客户端低于 0.5%，并发传输低于 1.75%。10 月 1 日自然跨日/月连续性与历史落盘通过；CI 的 AArch64/musl ABI
检查通过。全球 IPv6 WAN 上/下行已知大小验证通过，误差分别 +1.31% / +6.14%，归并到同一 MAC。
P0 尚未全部通过，详细范围、限制及剩余证据见
[真机验收记录](docs/TESTING.md#2026-09-30-nanopi-r5c-验收记录)。

| 优先级 | 工作 | 完成判据 |
| --- | --- | --- |
| P0：部署基线 | 最新提交 SDK 出包、安装、FFI 与数据准确性验收 | 三包能安装；ubus 返回正常；两台设备的方向与独立用量正确；记录固件、内核、提交及误差 |
| P1：稳定性与兼容 | 重启/校时/重连、长期存储、卸载路径和不同拓扑 | 有可复现的测试记录，明确支持与不支持的配置 |
| P2：功能与性能 | 大量设备、导出/备份、配置界面、高 PPS 优化 | 按需求实现并附对应性能或行为验证 |

### 优先验收：准确性与稳定性

- [ ] 使用匹配路由器的 SDK 编译最新版，运行 Rust 单元测试并验证 libubus FFI 布局。
- [ ] 真机核对 LAN 前缀、PPPoE WAN、不同设备的 MAC 筛选及上传/下载方向。
- [ ] 重启、跨日/月、NTP 校时、PPPoE 重连、接口变化后的统计连续性。
- [ ] 已知大小传输测试：LAN 互访、跨网段、IPv6、WAN，记录允许误差。
- [ ] 软件/硬件卸载关闭与开启时的覆盖率，明确支持配置。
- [ ] 长时间验证 7 天清理、SQLite 页复用、写入失败恢复及突然断电行为。
- [ ] 多桥、多 WAN、Wi-Fi、VLAN 和其他 CPU 架构验收。
- [ ] 将本地浏览器回归流程整理成可复现的仓库测试与 CI。

### 后续优化与可选功能

- [ ] 高 PPS 实测后决定 per-CPU 计数、减少 helper、批量读取 map 等优化。
- [ ] 移除剩余同步 ubus 发现/查询对事件循环的潜在阻塞。
- [ ] 大量设备分页、首页 50 台限制、历史设备淘汰、数据库空间监控。
- [ ] 数据导出、备份/恢复、采样/保留期限配置界面。
- [ ] 按设备保存实时速率历史；当前 7 天细粒度记录针对 WAN 上游接口。
- [ ] 视需求增加 DNS 分析、连接统计、限速和配额；当前尚未实现。

## 统计口径与限制

| 数据 | 来源与含义 |
| --- | --- |
| 设备实时速率、今日/本月/累计 | TC MAC 计数，包含实际经过采集钩子的 LAN 和 WAN 流量 |
| WAN 实时速率、累计发送/接收 | netlink 上游接口计数器；累计受接口/系统计数器重置影响，不是终身用量 |
| 7 天实时历史 | 默认路由上游接口的上传/下载速率，每 5 秒采样 |
| 设备日/月历史 | SQLite 用量汇总，查询窗口最近 90 天 / 12 个月 |

- **设备合计不必等于 WAN 总量**：采集位置、协议开销、路由器自身流量及 LAN-local 流量的口径不同。
- 硬件交换/卸载和加速路径可能绕过 TC，首次验收先关闭相关加速。不能凭“支持多个接口”认定复杂拓扑已验证。
- eBPF 不丢包、不限速、不改路由，但仍有逐包开销；低负载结果不能证明高 PPS 满速性能。
- 前缀学习失败时保留旧前缀；启动时若只剩默认前缀，本地流量分类可能不准确，应检查日志。
- 长区间图表显示平均速率，“最高显示速率”不是原始瞬时峰值。双轴刻度独立，不能直接比较曲线高度。
- 突然断电可能丢失最近约 5 分钟未落盘数据；正常退出会尝试最终落盘。
- 删除过期样本会复用 SQLite 页，文件不一定立即变小。设备累计/元数据不按 7 天自动删除。
- 日/月清理使用 `< cutoff`，物理保留可能包括额外边界日/月；90 天/12 个月是查询窗口。
- 时间有效性用时间戳门槛判断，不能替代 NTP 检查。实时查询用浏览器时区，日/月归档用路由器本地日期。

## 集成到 OpenWrt

### 1. 选择构建环境

| 使用场景 | 路径 |
| --- | --- |
| 自己编译固件，希望刷机后直接可用 | 第 2 步：在 OpenWrt 源码中选择三个包 |
| 已有固件，需要生成匹配的安装包 | 第 3 步：使用对应 SDK，再执行第 4 步 |
| 已有匹配固件和提交的构建产物 | 直接执行第 4 步，再检查采集配置和验收清单 |

ImageBuilder 可以把已编译且匹配的包装进镜像；本项目 Rust/eBPF 源码编译需要完整源码或 SDK。

重点目标是 **ucode LuCI 的 OpenWrt 25.x 系列**。SDK 工作流默认参数为 `25.12.5`、`x86/64`，只是仓库构建默认值，不是“最新版本”声明或全平台兼容保证。

- 在 Linux 或 WSL2 的 Linux 文件系统内构建；下面命令不是 PowerShell 命令。
- SDK、源码、feeds 与目标固件版本及 target/subtarget 匹配。
- ImmortalWrt 使用其对应源码/SDK/feeds；不要混装不同固件的内核模块。
- `kmod-*` 有内核 ABI 限制，CPU 架构相同不代表模块兼容。
- OpenWrt 24.x、旧 Lua LuCI、其他架构及厂商固件需要单独适配/验收。
- `all` 只代表 LuCI 包不含架构二进制，不代表跨 LuCI 版本无条件兼容。

### 2. 在源码中编进固件

从已准备好的 OpenWrt **源码根目录**执行，基础编译依赖按所选分支安装：

```sh
git clone https://github.com/zdabing/luci-zen.git ../luci-zen
cp -R ../luci-zen/luci-theme-zen package/
cp -R ../luci-zen/zen-traffic package/
cp -R ../luci-zen/luci-app-zen-traffic package/
./scripts/feeds update -a
./scripts/feeds install -a
make menuconfig
```

以上将三个包分别放在 `package/<包名>/`，与仓库 SDK 工作流的布局一致。若 `../luci-zen` 或目标包目录已经存在，复用并更新现有检出，避免重复克隆或把新目录嵌套进旧目录。使用软链接也可以，但源码目录必须在整个构建期间可访问。

选择目标设备，并选择下列包：

| menuconfig 位置 | 包 | 纳入固件 |
| --- | --- | --- |
| LuCI → Collections | 分支提供的完整 LuCI 集合，例如 `luci` | `[*]` |
| LuCI → Themes | `luci-theme-zen` | `[*]` |
| LuCI → Applications | `luci-app-zen-traffic` | `[*]` |
| Network | `zen-traffic` | `[*]`，通常由应用依赖选中 |

`[*]` / `=y` 纳入固件，`<M>` / `=m` 只生成安装包。只需主题时不选流量应用和后台。包依赖会选择 TC/BPF 内核模块；自定义内核仍需满足 BPF syscall、TC classifier 和所用 map/helper 条件。

```sh
make defconfig
make download -j8
make -j"$(nproc)" V=s
```

固件在 `bin/targets/<target>/<subtarget>/`，包在 `bin/packages/`；包格式由分支决定。GitHub SDK 工作流目前只收集 `.apk`。

### 3. 用 SDK 单独编译安装包

下载与固件匹配的 `openwrt-sdk-*.tar.zst`，后端还需要同一发布目录的 `llvm-bpf-*.tar.zst`。先核对该目录的 `sha256sums`。

下面先将路径替换成下载的实际文件名；`SDK_DIR` 替换成解压后的 SDK 目录：

```sh
SDK_ARCHIVE=/path/to/openwrt-sdk.tar.zst
LLVM_ARCHIVE=/path/to/llvm-bpf.tar.zst
SDK_DIR=/path/to/extracted-openwrt-sdk
tar --zstd -xf "$SDK_ARCHIVE"
cd "$SDK_DIR"
tar --zstd -xf "$LLVM_ARCHIVE"

git clone https://github.com/zdabing/luci-zen.git ../luci-zen
cp -R ../luci-zen/luci-theme-zen package/
cp -R ../luci-zen/zen-traffic package/
cp -R ../luci-zen/luci-app-zen-traffic package/
./scripts/feeds update -a
./scripts/feeds install rust libubus libubox clang bpf-headers luci-base

cat >> .config <<'EOF'
CONFIG_PACKAGE_luci-theme-zen=m
CONFIG_PACKAGE_zen-traffic=m
CONFIG_PACKAGE_luci-app-zen-traffic=m
EOF
make defconfig
make package/zen-traffic/compile V=s -j"$(nproc)"
make package/luci-app-zen-traffic/compile V=s -j"$(nproc)"
make package/luci-theme-zen/compile V=s -j"$(nproc)"

find bin/packages -type f \( -name '*zen*.apk' -o -name '*zen*.ipk' \)
```

llvm-bpf 解压到 **SDK 根目录**，参照 [SDK 工作流](.github/workflows/build.yml)。仅编主题不需要 Rust/eBPF 工具链。

只安装主题时，仅复制 `luci-theme-zen/`，feeds 安装 `luci-base`，只设置 `CONFIG_PACKAGE_luci-theme-zen=m` 并运行主题编译命令。首次完整后台构建可能需要编译 Rust 主机工具链，耗时和磁盘占用明显高于主题构建；编译失败时先用同一目标的 `V=s -j1` 获取完整错误。

后端使用 OpenWrt `rust-package.mk` 的目标 cargo/linker，`bpf.mk` 编译 eBPF，SQLite 为 bundled 构建。桌面 `cargo build` 产物不能代替 OpenWrt 包。两个 LuCI 包通过 `luci-base/host` 的 `po2lmo` 生成中文 `.lmo`。

官方参考：[使用 SDK](https://openwrt.org/docs/guide-developer/toolchain/using_the_sdk)、[使用构建系统](https://openwrt.org/docs/guide-developer/build-system/use-buildsystem)。

### 4. 安装到现有路由器

先确认版本、内核和包管理器：

```sh
ubus call system board
uname -r
command -v apk
command -v opkg
```

将匹配的三个包上传到 `/tmp`，每种包只放一个待安装版本；软件源/离线依赖也须匹配固件。可从构建机使用 `scp <实际包文件> root@<路由器IP>:/tmp/` 上传。先按包管理器运行 `apk update` 或 `opkg update` 更新索引；离线环境则需另外准备所有依赖包。仅有本项目三个包不代表依赖已齐全。

```sh
# apk 固件；本地构建包未配置项目签名仓库。
apk add --allow-untrusted /tmp/zen-traffic-*.apk \
  /tmp/luci-app-zen-traffic-*.apk /tmp/luci-theme-zen-*.apk

# opkg 固件：仅使用该固件 SDK 生成的 .ipk，不能安装 .apk。
opkg install /tmp/zen-traffic_*.ipk \
  /tmp/luci-app-zen-traffic_*.ipk /tmp/luci-theme-zen_*.ipk
```

按实际包管理器选一套命令。安装后在 LuCI“系统 → 系统 → 语言和界面”选择 Zen，也可显式设置：

```sh
uci set luci.main.mediaurlbase='/luci-static/zen'
uci commit luci
/etc/init.d/rpcd restart
/etc/init.d/zen-traffic enable
/etc/init.d/zen-traffic start
```

入口：**状态 → Zen 流量 → 设备 / 历史 / 实时流量历史**。主题首次启动脚本注册主题和静态缓存处理器；已有界面配置时仍需手动选择主题。

只安装主题时，安装命令只传主题包，跳过 `zen-traffic` 服务命令；没有后台时首页设备统计不会启用。安装或升级完成后强制刷新浏览器，再按下面的验收清单检查。

### 5. 首次部署验收

- [ ] `ubus call system board` 与构建记录的固件版本、target/subtarget 一致，依赖安装没有报错。
- [ ] Zen 登录页与首页能打开；中文、明暗模式、移动端布局正常。
- [ ] `ubus -v list zen.traffic` 能列出方法，`getStatus` / `getDevices` / `getTotal` 返回正常。
- [ ] LAN 采集接口确实存在；两台设备分别上传和下载时，MAC 归因、速率方向与日用量增量正确。
- [ ] 等待至少两次 5 秒采样，实时历史能查询；刷新首页能恢复最近历史。
- [ ] 正常重启服务后已有设备日/月用量仍可查询，日志没有 BPF 加载、数据库写入或前缀学习错误。
- [ ] 记录卸载开关、测试拓扑和传输误差；按 [真机测试基线](docs/TESTING.md) 继续验收。

这是首次部署检查，不代表多架构、长期运行和断电恢复等待办已完成。

## 采集与存储配置

配置文件 `/etc/config/zen-traffic`，默认 LAN 桥 `br-lan`，数据库 `/etc/zen-traffic/traffic.db`。

| UCI 项 | 默认值 | 含义 |
| --- | --- | --- |
| `traffic.enabled` | `1` | 服务开关 |
| `traffic.interface`（list） | `br-lan` | TC 挂载的 LAN 采集接口，不是 WAN 选择 |
| `traffic.interval` | `1000` | BPF map 轮询毫秒，最小 100 |
| `traffic.offline_timeout` | `600` | 离线判定秒数 |
| `traffic.checkpoint_secs` | `300` | 设备累计批量写盘周期，不改变 WAN 固定采样/落盘周期 |
| `traffic.db_path` | `/etc/zen-traffic/traffic.db` | 数据库，父目录须存在且可写 |
| `traffic.extra_prefix`（list） | 空 | 额外本地网段 CIDR |

```sh
uci -q delete zen-traffic.traffic.interface
uci add_list zen-traffic.traffic.interface='br-lan'
# 多桥按真实接口追加，并验证是否重复采集。
# uci add_list zen-traffic.traffic.interface='br-guest'
# 特殊本地网段可补充：
# uci add_list zen-traffic.traffic.extra_prefix='192.168.50.0/24'
uci commit zen-traffic
/etc/init.d/zen-traffic restart
```

不要把 `pppoe-wan` 替换进 LAN 采集列表做设备 MAC 归因。WAN 总量/实时历史通过默认路由上游识别；页面下拉框与 TC 挂载列表是不同概念。

长期使用可以将数据库迁移到已经挂载的持久存储：

1. 检查 `mount` / `df`，确认目标确实已挂载且有空间；目录存在不足以证明挂载成功。
2. `/etc/init.d/zen-traffic stop`，确认正常停止，备份原数据库。
3. 创建新目录，将旧 `.db` 复制到新位置；确认目标不存在以免覆盖旧记录。首次启动没有旧数据库则跳过复制。
4. 例如执行 `uci set zen-traffic.traffic.db_path='/mnt/data/zen-traffic/traffic.db'`，然后 `uci commit zen-traffic`。
5. `/etc/init.d/zen-traffic start`，检查日志和历史记录。

不要在服务正在写入时只复制主 `.db` 文件。存放 `/tmp` 会重启丢失；外置存储须在服务前挂载；自定义路径需自行配置 sysupgrade 保留/备份策略。

## 检查和排查

```sh
ubus -v list zen.traffic
ubus call zen.traffic getStatus
ubus call zen.traffic getDevices
ubus call zen.traffic getTotal
ubus call zen.traffic getHistory '{"agg":"day","mac":"38:65:04:6a:c0:9b"}'
ubus call zen.traffic getRealtimeHistory '{}'
ubus call network.interface dump
ip route show default
logread -e zen-traffic
```

MAC 换成真实设备，省略 `mac` 才是全部设备汇总。`getHistory` 的 `start_ms/end_ms` 是毫秒，`getRealtimeHistory` 的 `start/end` 是 Unix 秒。实时历史默认最近 5 分钟，启动初期要等待采样，不会补造停机期间的数据。

| 现象 | 排查重点 |
| --- | --- |
| 找不到 `zen.traffic` | 服务日志、BPF/TC 模块、可写数据库、包是否匹配固件 |
| WAN 数据为空/零 | 默认路由、实际上游、netlink 日志、重连后的计数基线 |
| `network.interface dump` 失败 | 日志细分原因、手动调用、是否部署解析修复后的 daemon |
| 不同设备历史相同 | 用不同 MAC 手动查询；需更新后端，刷新页面不能修旧 daemon |
| 中文页面仍有英文 | `.lmo` 安装、LuCI 语言选择、强制刷新、相关包一起升级 |
| 推送后页面没变化 | GitHub 源码推送不等于路由器更新，需匹配构建并安装 |

## 开发检查和发布

不构建目标二进制的检查：

```sh
node tools/check-po.js luci-theme-zen
node tools/check-po.js luci-app-zen-traffic
node tools/test-dashboard-history.cjs
python3 tools/test-sqlite-retention.py
python3 tools/test-realtime-history.py
git diff --check
```

覆盖翻译、部分前端行为和 SQLite SQL，不代替 Rust 编译、FFI 检查和真机验收。Rust 用例位于 `zen-ubus-sys`，执行需构建和满足链接环境。

- 普通 push / PR 触发 [CI](.github/workflows/ci.yml)，含 Rust 检查和 eBPF 编译。
- 只推源码不要编译：提交加 `[skip ci]`，不打 tag、不发布 Release、不手动运行构建。
- `v*` tag、发布 Release 或手动运行 **SDK Build** 触发正式出包，参数须与固件匹配。
- 工作流默认 `x86/64`，其他目标不视为已验证；包下载以成功构建的 Artifacts/Release 为准。

## 目录和文档

- [ARCHITECTURE.md](docs/ARCHITECTURE.md)：设计背景与采集架构；部分旧描述待同步，以当前代码及 README 状态为准。
- [DEVELOPMENT.md](docs/DEVELOPMENT.md)：本地开发和 SDK 构建。
- [TESTING.md](docs/TESTING.md)：真机验收基线。
- `dev-preview/`：脱机设计预览，非真实路由器数据，可能滞后于正式页面。
- `poc/`：实验验证，不是正式安装包。
- `tools/`：翻译和历史数据回归检查。

## 许可证

仓库默认许可及 `zen-traffic/` 为 [GPL-2.0](LICENSE)；主题为 [Apache-2.0](luci-theme-zen/LICENSE)。流量应用包声明 Apache-2.0，具体以组件许可证与源码声明为准。
