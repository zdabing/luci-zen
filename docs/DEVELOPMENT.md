# 开发指南

## 目录与工作流

- `luci-theme-zen/` — 主题包（静态 CSS/JS + ucode 模板），SDK 编译，arch 无关。
- `zen-traffic/` — Rust workspace（`crates/zen-trafficd` 守护进程、`crates/zen-bpf` Aya 封装、`crates/zen-ubus-sys` 手写 FFI）+ eBPF C 数据面 + OpenWrt 包 Makefile。
- `poc/` — 实验代码，不改正式行为；改动正式数据面前先在此验证。
- `reference/` — 第三方参考源码，仅本地对照（已被 `.gitignore` 排除）。

## 本地 Rust 开发

```sh
cd zen-traffic
cargo check --workspace     # CI 同款检查
cargo build --release       # 需本机 libubus/libubox（仅链接阶段需要）
```

`zen-ubus-sys` 不用 bindgen（避免 SDK 内 libclang 依赖），链接搜索路径：
优先 `UBUS_LIB_DIR` 环境变量（SDK 包 Makefile 会导出 `$(STAGING_DIR)/usr/lib`），
否则走系统默认路径。

## eBPF 数据面编译

数据面源码：`zen-traffic/bpf/zen_traffic.bpf.c`（与 `poc/bpf/` 同源）。
只依赖稳定 UAPI 与基础 helper，无 CO-RE / kfunc，不需要目标内核 BTF。

开发机（Linux，需 clang ≥ 支持 `-target bpf`、libbpf 头文件 `bpf/bpf_helpers.h`）：

```sh
clang -O2 -g -target bpf \
  -c zen-traffic/bpf/zen_traffic.bpf.c \
  -o /tmp/zen_traffic.bpf.o
```

SDK/内核树头文件：参照 `poc/rust-spike/scripts/build-bpf.sh` 的 `LINUX_DIR` 用法。
正式包内由 `zen-traffic/Makefile` 经 `bpf.mk` 的 `CompileBPF` 编译（llvm-bpf 全管线）。

## 主题设置与本地页面预览

当前主题为项目自有的「雾岚」：雾白/石墨灰底色、青绿强调色，使用 taste 仓库的现有界面优化规范设计。
颜色与组件规则集中在 `luci-theme-zen/htdocs/luci-static/zen/theme.css`，显示偏好由
`preferences.js` 管理；不再包含第三方配色、材质选择器或外观运行时。
主题使用 ucode、LuCI 原生 JavaScript 和 CSS，不引入前端框架。

首页由独立 `admin/zen` 路由的 `view/zen/home.js` 挂载，`dashboard.js` 提供数据与组件；
原生 `admin/status/overview` 的 action、权限和页面内容保持独立。
管理页右上角「Zen 设置」进入 `admin/status/zen-traffic/settings`；旧 `admin/system/zen`
保留无标题别名。外观标签复用 `ZenAppearance.render()`，版本标签按需启动更新模块。
登录页仍有显示设置弹窗及明暗快捷按钮，不写路由器配置。

支持跟随系统、浅色、深色，以及左侧/顶部导航。主题自身不提供配色和材质预设。
既有 `luci-theme-zen` 明暗键和 `luci-theme-zen-layout` 布局键继续使用；旧配色/材质键被忽略。
已登录会话通过原生 UCI 适配器保存显示模式与布局，按修改字段串行提交，失败可重试；
已保存的路由器配置优先于浏览器缓存。首次迁移保留已有明暗和布局选择。

从仓库根目录启动：

```sh
python dev-preview/serve.py
```

打开 `http://127.0.0.1:8770/dev-preview/runtime.html?page=dashboard`。
预览服务对 HTML、脚本和样式发送 `no-store`；页面跳转携带预览版本，避免旧页面缓存重新加载已移除的主题。
`page` 也可为 `realtime`、`history`、`notifications`、`login`。
`page=overview` 仅展示原生概览的独立入口占位；完整原生页面需要在路由器验收。
此预览加载正式 LuCI 渲染模块和真实中文翻译，以模拟 RPC 数据验收布局；
修改/发送/清零 RPC 均拒绝，不连接路由器。`dev-preview` 不安装到目标包。

```sh
node tools/test-appearance.cjs
node tools/test-home-view-lifecycle.cjs
# 可选：开发环境已提供 Playwright 和浏览器时运行。
node tools/test-appearance-browser.cjs
```

浏览器测试支持 `ZEN_PREVIEW_URL`、`ZEN_BROWSER_CHANNEL`（如 `msedge`）及
`ZEN_SCREENSHOT_DIR`。浏览器依赖仅用于开发验收，不加入主题部署包。
`node tools/test-console-browser.cjs` 验收图标导航、设备抽屉、筛选、批量选择、无导出入口和批量重置。
默认截图保存在 `acceptance-out/console/`。预览默认拒绝写操作；该测试显式开启的设备重置
只改内存样本，不连接生产设备。设备详情使用原生 dialog；批量确认和身份编辑沿用 LuCI 弹窗。
Windows 未安装 GNU make 时，安装资产检查可把 `ZEN_TEST_BASH` 设为 Git Bash 的
绝对路径，再运行 `python tools/test-package-assets.py`；测试仍执行包中的原安装配方。

## 设备管理接口

设备详情的重命名调用既有 `zen.traffic.setHostname`，名称存入 SQLite 并由后续设备快照恢复。
限速和拉黑通过 `getDevicePolicy` / `setDevicePolicy` 管理；限速参数为十进制 kbit/s，0 表示不限速。
策略在 SQLite 的 `device_policies_v1` 设置中持久化，启动时在接口挂载前恢复到 BPF map。
保存失败会恢复先前内核策略；取消限速和解除拉黑各自保留另一项设置。
这些策略由 `zen-traffic` 服务执行，停止服务会停止执行；硬件流量卸载或接口不可用时拒绝新增限制。
不自动修改用户的硬件卸载设置，也不替换现有 SQM qdisc。限速使用丢包 policing，允许短时突发。

固定 IPv4 使用 `zen.device.getBinding` / `setBinding` rpcd 插件。插件以独立 libuci delta 目录
提交 DHCP 静态租约，只操作目标 MAC，检查启用 DHCP 的 LAN 子网、网关和占用冲突。
dnsmasq 重载失败时恢复原配置；共享 MAC 租约拒绝直接改 IP，解除绑定仅移除目标 MAC。
绑定在设备下次 DHCP 续租时生效，不伪造当前地址变化。四项写操作由独立
`zen-device-management` ACL 控制，前端收到后端成功响应后才更新状态。

本地 `refined.html` 使用同一正式控制模块及内存 RPC 样本，可验证交互，不修改路由器。

`zen.device.getConnections` 为只读连接属性接口：通过本机 `iwinfo.devices/info/assoclist`
读取客户端信号、连接时长及上/下行协商速率（kbit/s 转 Mbps）；通过桥接 FDB 匹配
物理端口并读取 sysfs 协商速率。无法匹配、端口掉线或映射冲突时不填速率；不将
路由器运行时间、DHCP 租约时长、FDB 老化时间作为有线终端的连接时长。
接口不执行命令或主动扫描，不修改配置；主题每 15 秒读取一次，45 秒后丢弃过期属性。
Wi-Fi 信息限于本机 AP 能报告的客户端；有线速率表示路由器对应端口，不能证明下级交换机
后终端的协商速率。离线行使用已有持久化的最后活动时间。

## i18n 校验

```sh
node tools/check-po.js luci-theme-zen
node tools/check-po.js luci-app-zen-traffic
```

翻译源为主题和应用各自的 `po/zh_Hans/*.po`；`.lmo` 由 SDK 构建时
使用 `luci-base/host` 提供的 `po2lmo` 生成。缺失工具或转换失败会报错，不再静默跳过。
安装的独立语言包为 `zen.zh-cn.lmo` 与 `zen-traffic.zh-cn.lmo`。

## OpenWrt 25 SDK 手动编译

CI（`.github/workflows/build.yml`）按以下流程执行，本地手动操作一致。
完整的三包集成、固件内置、SDK 编译、安装与配置步骤以 [README](../README.md) 为准。
SDK 从 <https://downloads.openwrt.org/releases/> 下载对应目标架构的
`openwrt-sdk-*.tar.zst`（CI 默认 25.12.5，同时构建 x86/64 和 rockchip/armv8）；若编译含 eBPF 的包，还需同目录的
`llvm-bpf-*.tar.zst` 解压进 SDK 根目录。

### luci-theme-zen（arch: all）

```sh
tar --zstd -xf openwrt-sdk-*.tar.zst && cd openwrt-sdk-*/
./scripts/feeds update -a
./scripts/feeds install luci-base
cp -r /path/to/luci-theme-zen package/
make defconfig
make package/luci-theme-zen/compile V=s
# 产物在 bin/packages/ 的架构/仓库子目录中，由构建分支决定格式。
```

### zen-traffic（交叉编译 Rust + eBPF）

```sh
./scripts/feeds update -a
./scripts/feeds install rust libubus libubox clang bpf-headers luci-base
cp -r /path/to/zen-traffic package/
make defconfig
make package/zen-traffic/compile V=s -j$(nproc)
# 产物：find bin/packages -type f -name 'zen-traffic*.apk'
```

`rust-package.mk` 负责导出 target cargo/linker；`rusqlite` 为 bundled
（需要 target cc）；`UBUS_LIB_DIR` 由包 Makefile 导出。

## CI / 发布

- `ci.yml`：push / PR → `cargo check` + eBPF 对象编译 + `.po` 校验。
- `build.yml`：推送 `v*` 标签后，OpenWrt 25.12.5 SDK 同时为 `x86/64` 和 `rockchip/armv8` 编译四个包（luci-theme-zen、zen-traffic、luci-app-zen-traffic、zen-full），构建成功后发布正式 Release。附件带 target 后缀，包含双目标更新元数据和 SHA256SUMS。手动触发的 `sdk_target` 默认 `both`，也编译这两个目标；需要单独验收时可显式填写一个 target/subtarget。开启 `publish_release` 时生成预发布；签名软件源单独通过 `publish_repository` 按各 target 发布。
  当前仅 x86_64（`x86/64`）目标，扩展其它架构时在 build.yml 增加 matrix。
