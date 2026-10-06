# LuCI Zen

面向使用 ucode LuCI 的 OpenWrt 系固件（包括 ImmortalWrt）的主题与流量统计插件，提供仪表盘、实时监控、历史分析和飞书/企业微信通知。

| 包 | 用途 |
| --- | --- |
| `luci-theme-zen` | Zen 主题、登录页和首页仪表盘，可单独安装 |
| `zen-traffic` | 流量采集与存储后台 |
| `luci-app-zen-traffic` | 流量页面，依赖 `zen-traffic`，也可在其他主题下使用 |
| `zen-full` | 通过已配置的 Zen 软件源安装主题和流量整套依赖 |

## 安装与使用

签名 APK 软件源、整套安装入口和自编译固件的兼容范围，见 [APK 安装与发布](docs/APK-DISTRIBUTION.md)。对应软件源需要维护者先完成签名发布。

从 [Releases](https://github.com/zdabing/luci-zen/releases) 或 [构建产物](https://github.com/zdabing/luci-zen/actions/workflows/build.yml) 下载包，上传到路由器 `/tmp`。主题和流量页面包为 `all` 架构；后台包须匹配固件版本与 target/subtarget。每种包只放一个版本，按实际包管理器选择一组命令：

```sh
# apk 固件
apk update
apk add --allow-untrusted /tmp/zen-traffic-*.apk \
  /tmp/luci-app-zen-traffic-*.apk /tmp/luci-theme-zen-*.apk
```

```sh
# opkg 固件：使用对应 SDK 生成的 .ipk
opkg update
opkg install /tmp/zen-traffic_*.ipk \
  /tmp/luci-app-zen-traffic_*.ipk /tmp/luci-theme-zen_*.ipk
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

只使用主题时，仅安装 `luci-theme-zen`，跳过流量服务命令。安装或升级后强制刷新浏览器。

- **首页仪表盘**：查看系统、网络和设备用量；右上角「Zen 设置」调整外观、布局及检查 Zen 软件包更新。
- **外观与布局**：登录后修改会保存到路由器，颜色、材质、深浅模式及导航布局在不同浏览器间共享；登录页的临时调整不会修改路由器设置。首次迁移会保留已有浏览器中的偏好。
- **状态 → Zen 流量**：进入实时监控、历史分析、通知设置。
- **通知设置**：默认关闭，配置飞书或企业微信 Webhook，测试成功后启用阈值提醒或每日报告。

## 集成到固件

以下构建命令在 Linux 或 WSL2 的 Linux 文件系统内执行。OpenWrt / ImmortalWrt 源码、feeds 和目标设备须匹配；基础构建环境需提前准备好。

在固件源码根目录执行：

```sh
git clone https://github.com/zdabing/luci-zen.git ../luci-zen
cp -R ../luci-zen/luci-theme-zen package/
cp -R ../luci-zen/zen-traffic package/
cp -R ../luci-zen/luci-app-zen-traffic package/
./scripts/feeds update -a
./scripts/feeds install -a
make menuconfig
```

已有仓库或包目录时更新现有检出，避免重复复制导致目录嵌套。在 `menuconfig` 中选择目标设备和 LuCI 集合（如 `luci`），再选择：

| 菜单 | 包 |
| --- | --- |
| LuCI → Themes | `luci-theme-zen` |
| LuCI → Applications | `luci-app-zen-traffic` |
| Network | `zen-traffic`（通常由应用依赖选中） |

选 `[*]` 内置固件，选 `<M>` 只生成安装包。仅需主题时只选 `luci-theme-zen`。

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

包格式由固件分支决定，编译完成后按上面的安装步骤操作。只编译主题时，仅复制主题目录、安装 `luci-base` feed、设置主题为 `m`，执行主题编译命令；无需 Rust/eBPF 工具链。ImageBuilder 可集成已编译且匹配的包。

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

详细说明：[页面与通知](docs/TRAFFIC_PAGES_AND_NOTIFICATIONS.md) · [版本与更新](docs/VERSIONS_AND_UPDATES.md) · [开发指南](docs/DEVELOPMENT.md) · [测试记录](docs/TESTING.md) · [更新日志](CHANGELOG.md)。
