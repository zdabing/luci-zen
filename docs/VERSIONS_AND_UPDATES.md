# Zen 设置与版本更新

右上角「Zen 设置」和「状态 → Zen 流量 → Zen 设置」进入独立路由 `admin/status/zen-traffic/settings`（旧 `admin/system/zen` 地址保留隐藏别名，系统菜单不再显示设置入口），包含「外观与布局」和「版本与更新」两个标签。版本页仅显示 `luci-theme-zen`、`luci-app-zen-traffic`、`zen-traffic` 三个包的实际安装版本；点击「刷新版本」重新读取本机，点击「检查更新」读取 `zdabing/luci-zen` 的 GitHub 正式发布。不检测固件更新，不读取 10Wrt 构建标识，也不提供固件下载或刷写入口。

首页不加载更新模块；设置页切入版本标签才读取包清单。GitHub 检查需手动点击，不自动安装。登录页保留外观弹窗。

## 软件包更新

每个包独立比较安装版本和发布版本。主题与流量页面为 `all` 架构，不按固件品牌、target 或 SDK 版本限制更新查询；原生后台包需匹配本机 target 和 OpenWrt 大版本（如 `24`、`25`）。OpenWrt、ImmortalWrt 及其他 OpenWrt 系固件共用同大版本的更新候选，不区分小版本、补丁版本或带版本号的 Snapshot。只为已安装的包提供 APK 下载，不要求安装可选组件，也不要求三个包版本一致。

展开 APK 文件条目可查看下载链接和 SHA256，下载后通过「管理 Zen 软件包」进入 OpenWrt 原生软件包页面上传安装，也可使用该页面的软件源更新。`all` 代表包不含目标二进制，主题仍需要 ucode LuCI；安装时继续由包管理器检查实际依赖。

没有软件包管理权限或未安装原生页面时隐藏入口，只读账号显示「只读」。安装继续使用 OpenWrt 原有权限、依赖和签名校验；更新页不授予写入权限或修改软件源。

## 信息来源与匹配

- 安装版本：优先读取原生 `package-manager-call list-installed`，回退到 APK 数据库或 opkg status。读取失败显示「无法读取」，可读数据库中缺少包才显示「未安装」。Cargo 版本仅用于发现运行服务与安装包的版本差异，不替代包修订号。
- 后台包兼容性：通过 `system.board` 读取 target 和固件版本，与发布的 `target` 和 `sdk_version` 大版本比较，仅用于筛选匹配的 `zen-traffic` APK。例如 SDK `25.12.5` 可匹配同 target 的 OpenWrt / ImmortalWrt `25.12-SNAPSHOT`、`25.12.6`、`25.01.2`，不能匹配 `24.10.x`。只有 `SNAPSHOT` 而没有数字版本时不猜测所属大版本。
- 旧发布的 `compatible_systems` 保留为测试记录，不再作为发行版和完整版本号白名单，也不能覆盖 SDK 的大版本。已有有效元数据无需重新发布即可按新规则匹配。更新候选不保证所有自编译固件的 ABI 或内核能力；安装仍检查实际依赖，内核模块仍需来自当前固件的软件源。
- 发布信息：工作流运行 `tools/make-release-metadata.py`，核对所选包的 Makefile 版本、修订号和实际 APK，计算 SHA256，产出 `zen-update.json` 并写入发布正文的 `<!-- zen-update-metadata ... -->` 标记。所选包缺失、重复或为空会终止发布；各包可以独立修订和发布。

推送 `v*` 标签会使用 OpenWrt 25.12.5 SDK 同时构建 `x86/64` 和 `rockchip/armv8`，两种构建都成功后才创建正式 Release。每个附件名称带 target 后缀；原有 schema 1 顶层记录保留第一个目标，额外目标放入 `builds`，更新页逐个目标筛选后台。旧页面仍能读取顶层主题包，升级主题后可识别其他目标。发布前重新核对所有 APK 的版本、大小和 SHA256，并附带 `SHA256SUMS`。手动整套构建仍选择单个目标，发布为预发布。

`Theme APK release` 工作流使用 SDK 只编译主题。手动启用 `publish_release` 后发布正式 `theme-v<版本>-r<修订号>` Release，包含主题 APK、更新元数据、SHA256SUMS 和源码记录；关闭时仅保留构建产物。单独主题发布不隐藏其他包此前的发布。

浏览器读取 GitHub API 的发布正文元数据，核对仓库、tag、附件名称、大小及可用的 digest。按数值比较包版本和修订号；未知版本、缺少有效元数据、目标不匹配、断网、15 秒超时或限流均不会显示「已是最新」。查询最近 100 个发布，不计入预发布。

读取权限只包含包清单 helper 和包数据库；数据库回退使用 CGI 直接读取，避免 ubus 大消息截断。不需要 LuCI 版本查询或固件构建标识读取权限。

## 验证

`node tools/test-zen-updates.cjs` 和 `python tools/test-release-metadata.py` 验证安装版本解析、比较、target/大版本匹配、旧元数据及权限。浏览器回归使用实际 LuCI 模块和只读 fixtures：`tools/test-zen-settings-browser.cjs` 检查设置入口、外观、键盘标签和延迟读取；`tools/test-zen-updates-browser.cjs` 检查三个包、OpenWrt / ImmortalWrt 同大版本更新与跨版本拒绝、单一 Zen 更新源、响应式布局、故障回退、权限及无固件操作。

本地预览的软件包链接显示入口占位，实际安装流程需在 OpenWrt 上验收。旧发布没有有效更新元数据时，不推测其兼容性或是否最新。
