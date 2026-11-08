# LuCI Zen

面向使用 ucode LuCI 的 OpenWrt 系固件（包括 ImmortalWrt）的主题与流量统计插件，提供仪表盘、实时监控、历史分析和飞书/企业微信通知。

| 包 | 用途 |
| --- | --- |
| `luci-app-zen` | 全部页面：Zen 主题、登录页、首页、历史分析、通知和设置；架构为 `all` |
| `luci-zen` | Rust/eBPF 采集、设备统计、SQLite 存储及后台服务；匹配目标架构 |

当前发布版本为 **0.2.5-r4**，前后端包均为 **0.2.5-r4**。识别进程 IPC 已更新，升级时请配套安装两个包。

从 0.2.4 起，每个 target 只生成两个 APK；`luci-app-zen` 依赖 `luci-zen`。旧的主题包、流量页面包和 `zen-full` 合并为前端包，不再单独出包。

## 0.2.6-r1 测试构建：严格 P2P 控制

设备详情提供默认关闭的 UDP 端点隔离，可选“仅观察”或“拦截冲突节点”。同一设备、源 IP、UDP 源端口在空闲超时内锁定第一个远端 IP 和端口，默认超时 120 秒，可设为 30–600 秒。匹配的双向数据包刷新超时，冲突包不刷新；观察模式只统计，不丢包。保存策略后重新建立该设备的端点锁，设置保存在现有 SQLite 配置中。

每设备最多八条远端 IP/CIDR 放行规则，支持 IPv4、IPv6，仅绕过匹配的数据包，不把整个本地端口改成 Full Cone。LAN 前缀、TCP 不受影响。不修改 OpenWrt NAT、防火墙或代理配置。启用前需要关闭软硬件流量分载，服务拒绝在分载开启、状态未知或无挂载接口时启用；关闭始终允许。之后改变分载配置可能绕过策略，页面会提示当前覆盖状态。

此功能抑制部分 P2P 打洞，不能识别或保证封禁全部 PCDN，也可能影响游戏、通话、QUIC 端点迁移和组网 VPN。IPv4 分片、带扩展头的 IPv6 不处理。全局端点表上限 16384，表满时放行新端点并增加容量不足计数；每 30 秒回收空闲超过 20 分钟的记录，并发回收可能使个别端点重新建立锁，因此它不是安全隔离边界。页面按设备显示冲突、拦截、规则放行、解析跳过、容量不足的数据包数，计数与端点状态在服务重启后清零。透明代理及目标设备上的长期运行仍需实机验收。

## 编译与发布

推送 `v*` 版本标签会构建 `x86/64` 和 `rockchip/armv8` 两个目标，全部成功后创建正式 GitHub Release，附对应版本的更新日志、四个 APK（每种目标两个）、`zen-update.json` 和 `SHA256SUMS`。发布前需更新两个包的版本及 CHANGELOG 中对应条目。

手动运行 `SDK Build` 时，`publish_release` 默认开启，成功后创建预发布；关闭它则仅保存 Actions Artifacts，产物中仍包含本版更新日志。普通 main 提交只运行 CI，不会自动打包或发布。`publish_repository` 是另一个签名软件源开关，普通 Release 无需开启。

## 安装与使用

维护者可通过 GitHub Actions 发布按 SDK 和目标划分的签名 APK 软件源。软件源上线后可使用随 Release 提供的 `install-zen.sh` 安装；首次信任公钥前需核对发布说明中的 SHA256 指纹。

从 [Releases](https://github.com/zdabing/luci-zen/releases) 或 [构建产物](https://github.com/zdabing/luci-zen/actions/workflows/build.yml) 下载包，上传到路由器 `/tmp`。页面包为 `all` 架构；后台包须匹配固件大版本与 target/subtarget。`v*` 标签发布提供 OpenWrt 25 的 `x86/64` 和 `rockchip/armv8` 两组附件，按文件名的目标后缀选择一组。每种包只放一个版本，按实际包管理器选择一组命令：

```sh
# apk 固件
apk update
apk add --allow-untrusted /tmp/luci-zen-*.apk /tmp/luci-app-zen-*.apk
```

```sh
# opkg 固件：使用对应 SDK 生成的 .ipk
opkg update
opkg install /tmp/luci-zen_*.ipk /tmp/luci-app-zen_*.ipk
```

依赖由匹配的软件源安装；离线安装需另外准备依赖包。内核模块必须匹配固件 ABI，不能只按 CPU 架构选包。

安装后，在 LuCI「系统 → 系统 → 语言和界面」选择 Zen，或执行：

```sh
uci set luci.main.mediaurlbase='/luci-static/zen'
uci commit luci
/etc/init.d/rpcd restart
/etc/init.d/zen-traffic enable
/etc/init.d/zen-traffic start
```

从旧版迁移时，将两个新 APK 放在同一次安装中，使用 `apk add --upgrade --allow-untrusted /tmp/luci-zen-*.apk /tmp/luci-app-zen-*.apk`。新包通过 `PROVIDES` 接管旧包名；不要提前卸载旧包，也不要删除配置或数据库。旧版更新页不认识新包名，首次迁移需手动安装，后续更新页只显示两个新包。

后台运行名仍为 `zen-trafficd`，服务仍为 `/etc/init.d/zen-traffic`，UCI 与数据库路径保持原样。安装或升级后强制刷新浏览器。

- **首页仪表盘**：四张卡片显示 CPU、内存、温度和连接数；网络地址随 IPv6 有无调整布局，并查看实时网速和设备用量；右上角「Zen 设置」选择 Meridian 橙彩玻璃或 Apple 清爽卡片主题、调整显示模式和导航布局，并检查 Zen 软件包更新。
- **外观与布局**：登录后修改会保存到路由器，深浅模式及导航布局在不同浏览器间共享；登录页的临时调整不会修改路由器设置。首次迁移会保留已有浏览器中的偏好。
- **Zen 导航**：网络概览、流量分析、设置；通知与版本更新统一放在设置页。
- **通知设置**：默认关闭，配置飞书或企业微信 Webhook，测试成功后启用阈值提醒或每日报告。
- **应用用量（0.2.4-r2 起）**：在流量分析中选择设备、日期和小时，查看该时段各应用/服务的上传、下载和总量。0.2.4-r3 后台升级到 nDPI 6.0，识别进程与统计守护进程分开运行，仍只交付两个 APK。默认按个人、非营利用途启用上游完整识别模式；商业用途需遵循上游双许可说明，详见 `luci-zen/appid/NOTICE`。

应用记录从升级后开始采集，不补算旧历史，按小时保存最多 30 天；应用/服务、仅识别到的协议、连接未识别、识别中和未归属差额分开展示。识别依据协议特征和可见域名，不等同于终端进程统计；ECH、VPN/代理、共享 CDN 和硬件流量加速可能影响覆盖率。只统计经过 LAN 采集点的互联网流量，不解密 HTTPS，不保存载荷或访问 URL。设备与应用的采样边界可能略有差异，页面会提示，不伪造应用分配。

识别仅处理连接开头最多 32 个包、每包最多 4096 字节，后续字节由内核连接计数器累计。内核连接表上限 16384 条，采样缓冲 8 MiB；独立识别进程限制 128 MiB 地址空间并在启动后放弃 root 身份。写入按五分钟批量执行，设备小时总量与应用明细在同一事务提交；存储失败保留待写缓存，容量或行数上限触发时缩短可查询范围，不把缺失记录当作零用量。

## 集成到固件

以下构建命令在 Linux 或 WSL2 的 Linux 文件系统内执行。OpenWrt / ImmortalWrt 源码、feeds 和目标设备须匹配；基础构建环境需提前准备好。

在固件源码根目录执行：

```sh
git clone https://github.com/zdabing/luci-zen.git ../luci-zen
cp -R ../luci-zen/luci-app-zen ../luci-zen/luci-zen package/
./scripts/feeds update -a
./scripts/feeds install -a
make menuconfig
```

已有仓库或包目录时更新现有检出，避免重复复制导致目录嵌套。在 `menuconfig` 中选择目标设备和 LuCI 集合（如 `luci`），再选择：

| 菜单 | 包 |
| --- | --- |
| LuCI → Applications | `luci-app-zen` |
| Network | `luci-zen`（由页面包依赖选中） |

选 `[*]` 内置固件，选 `<M>` 只生成安装包。选择页面包时自动选择后台依赖。

```sh
make defconfig
make download -j8
make -j"$(nproc)" V=s
```

固件输出到 `bin/targets/<target>/<subtarget>/`，安装包输出到 `bin/packages/`。

## 使用 SDK 编译安装包

下载与目标固件匹配的 SDK，以及同一发布目录的 `llvm-bpf-*.tar.zst`，核对 `sha256sums`。解压 SDK 后，将 llvm-bpf 解压到 **SDK 根目录**，在该目录执行：

```sh
git clone https://github.com/zdabing/luci-zen.git ../luci-zen
cp -R ../luci-zen/luci-app-zen ../luci-zen/luci-zen package/
./scripts/feeds update -a
./scripts/feeds install rust libubus libubox clang bpf-headers luci-base

cat >> .config <<'EOF'
CONFIG_PACKAGE_luci-app-zen=m
CONFIG_PACKAGE_luci-zen=m
EOF
make defconfig
make package/luci-zen/compile V=s -j"$(nproc)"
make package/luci-app-zen/compile V=s -j"$(nproc)"

find bin/packages -type f \( -name '*zen*.apk' -o -name '*zen*.ipk' \)
```

包格式由固件分支决定，编译完成后按上面的安装步骤操作。两个源码目录需一并放入 SDK，确保依赖元数据完整。ImageBuilder 可集成已编译且匹配的包。

## 采集配置与检查

默认采集 LAN 桥 `br-lan`，配置文件为 `/etc/config/zen-traffic`。如果实际 LAN 接口不同，修改后重启服务：

```sh
uci -q delete zen-traffic.traffic.interface
uci add_list zen-traffic.traffic.interface='br-lan'
uci commit zen-traffic
/etc/init.d/zen-traffic restart
```

这里配置的是 LAN 采集接口。后台会将网桥自动展开为成员端口并去重，使软件流量卸载仍经过设备采集点；网络事件及周期检查会更新端口挂载。

WAN 总量通过默认路由上游识别；PPPoE 使用 netifd 提供的底层设备计数，避免软件卸载绕过 PPP 虚拟接口。IPv4/IPv6 共用的设备只计一次，VLAN 保留其独立设备。此口径包含接口封装开销；同一底层设备承载多个 PPPoE 会话时统计的是该底层设备合计，不提供各会话拆分。

`getStatus` 的 `offload` 根据实际 nftables 流表返回 `off`、`sw`、`hw` 或无法检测时的 `unknown`，另有 `hardware_offload_requested` 与 `hardware_offload_active` 区分硬件请求和已观察到的硬件卸载。真正绕过 CPU 的硬件卸载、硬件交换流量仍可能漏计，要求完整设备统计时关闭硬件流量卸载。

数据库默认保存在 `/etc/zen-traffic/traffic.db`。自定义持久存储可设置 `zen-traffic.traffic.db_path`，目标目录须提前挂载且可写；迁移旧数据前先停止服务并备份，避免存放在重启会清空的 `/tmp`。

```sh
ubus call zen.traffic getStatus
ubus call zen.traffic getDevices
logread -e zen-traffic
```

确认服务返回正常、设备上传/下载方向正确；实时历史启动后需等待采样。

源码中的 DPI 诊断接口可区分当前连接的应用、仅协议识别、Unknown 和待识别用量，并报告有域名仍未归类、TLS/QUIC 无域名、规则冲突及采样队列状态：

```sh
ubus call zen.traffic getDpiDiagnostics
```

接口沿用 `getAppUsage` 的 `{ "json": "…" }` 返回格式。这是最近仍保留的连接快照，空闲 120 秒后移除，字节来自 eBPF 连接计数器；它不等同于选定小时的历史总量，也不能单凭汇总数字认定真实识别率。硬件卸载、采集接口及进程失败信息同时返回，便于区分归类失败和采集缺口。

默认不返回连接、IP 或域名明细。需要排查时，可在有写权限的会话中短时开启，再按设备 MAC 查询；最多 300 秒，到期或设为 0 后清除域名明细，仅保存在内存：

```sh
ubus call zen.traffic setDpiDiagnostics '{"seconds":60}'
ubus call zen.traffic getDpiDiagnostics '{"mac":"02:00:00:00:00:01","limit":20}'
ubus call zen.traffic setDpiDiagnostics '{"seconds":0}'
```

域名明细只包含开启窗口内收到识别结果的连接，无法追溯开启前的域名。识别进程通过版本 2 的 IPC 返回原始 nDPI 应用、主协议、置信来源及可见主机名；新旧格式不兼容时停止应用采样，设备字节统计继续运行。

## 国内应用归属与规则

nDPI 6.0 的原生结果先经过独立 Rust 归属层，再写入小时账本。具体应用的原生结果默认保留；专属域名可细分 Unknown、通用协议及厂商分类，冲突单独报告。共享 CDN、整个 `qq.com`、`gtimg.com` 和云厂商 IP 不直接计入腾讯视频等应用。

随源码提供的 `zen-cn-20261106.2` 社区规则包包含 256 条筛选规则，其中 48 条允许专属服务归属，其余为诊断候选或基础设施；另保留 14 条内置专属规则。覆盖腾讯视频、爱奇艺、优酷、哔哩哔哩、芒果 TV、抖音、快手、斗鱼、虎牙和腾讯游戏；微信、QQ 等仍可使用原生识别及内置规则。域名来源和筛选结果不等于真实播放识别率。

社区元数据固定上游提交，来源见 `luci-zen/rules/SOURCES.json`，MIT 许可随包安装。离线构建工具支持 BetterDPI 导出的 MIT 域名元数据或本地 domain-list-community 数据目录；只读取文件，不联网，不执行来源代码。`review.json` 决定哪些域名可以作为直接应用证据：

```sh
python3 luci-zen/scripts/build-app-rules.py \
  --source /path/to/community-rules.json \
  --output /tmp/china-apps.json

# 也可使用固定提交的 DLC data 目录：
python3 luci-zen/scripts/build-app-rules.py \
  --source /path/to/domain-list-community/data \
  --revision <40-character-commit-sha> --output /tmp/china-apps.json
```

LuCI「应用用量」的高级选项可导入、校验、应用、导出和回滚规则，并保存本地误判反馈。后台接口如下；`setDpiRules` 的 `json` 参数为完整规则包的 JSON 字符串，先校验后原子替换：

```sh
ubus call zen.traffic getDpiRules
ubus call zen.traffic rollbackDpiRules
ubus call zen.traffic getAppRealtime '{"mac":"02:00:00:00:00:01"}'
```

活动规则与上一版本保存在数据库所在目录的 `app-rules.json`、`app-rules.previous`，文件权限为 0600。包限制为 512 KiB、2048 条域名规则；同版本不同内容会拒绝，非法包不覆盖活动版本，启动发现损坏时恢复有效旧版或内置规则。规则更新对后续识别生效，已完成识别的连接及历史统计不批量重算。

可选的报文特征模块支持协议、端口和多个有界载荷片段组合，但目前只返回诊断候选；内置特征列表为空。尚未通过真实流量验证的特征不会计入具体应用。

## DNS 辅助识别与小时账本

DNS 辅助默认关闭，可在高级选项开启或调用接口；开关保存在原数据库设置中，重启后恢复：

```sh
ubus call zen.traffic setDpiDns '{"enabled":true}'
ubus call zen.traffic setDpiDns '{"enabled":false}'
```

独立的 eBPF 元数据通道观察设备与 DNS 服务之间的 UDP/53 查询及应答，包括设备向路由器本地 DNS 发出的请求。只接受已观察到查询、问题与应答匹配的 A/AAAA/CNAME 关联，按设备、真实目的 IP 和 TTL 缓存；多应用或未知服务共用 IP 时不强行归属，Fake-IP 和非公网地址不作为应用证据。它仅在缺少可见主机名且原生结果通用时辅助分类，不修改解析器、DNS 应答或防火墙。DoH、DoQ、DNS over TCP、ECH 及采集不到的流量仍有可观察性限制。

DNS 关联只在内存中保存，过期、关闭或更新规则时清除；不新增报文、URL 或域名访问历史文件。工作进程保留降权、内存和崩溃转储限制，持有瞬时样本的主进程也禁用崩溃转储。

小时统计保留原表和原数据，新增来源明细表记录归属依据及规则版本。社区应用使用稳定的 `community:*` 标识，云服务使用 `infra:*`，与 `ndpi:*` 分开；旧记录缺少来源时显示旧版来源，不补造识别证据。暂记 Unknown 的迟到纠正与来源明细在同一事务中转移；字节始终来自原有 eBPF 连接计数器。

页面保留「设备 → 日期 → 小时」，增加视频排行、来源展开、当前小时实时应用速率，以及单独的协议、CDN/云和未归属分组。覆盖率表示已归属应用的字节占比，不是经人工核验的准确率。实时速率来自同一批连接字节差值，不另建一套计费账本。

当前未发布代码已进行隔离 Linux 环境的单元、真实内核采样和 ubus 接口验证；路由器暂不可达，国内视频实播、Fake-IP/透明代理、软硬件卸载及长期 CPU/内存表现仍需设备验收。

版本变更见 [更新记录](CHANGELOG.md)。仓库只维护正式前后端源码及构建发布脚本；本地测试、预览、文档和验收资料不进入发布源码。
