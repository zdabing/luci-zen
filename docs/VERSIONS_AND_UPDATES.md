# Zen 设置与版本更新

右上角「Zen 设置」和「系统 → Zen 设置」都进入独立路由 `admin/system/zen`。页面包含「外观与布局」和「版本与更新」两个标签。前者复用 `appearance.js` 的控制与本地偏好，后者显示路由器的固件、内核、LuCI 和三个 Zen 包的实际安装版本。点击「刷新版本」重新读取本机；点击「检查更新」分别读取 `zdabing/luci-zen` 与 `zdabing/10Wrt` 的 GitHub 正式发布。首页仅保留监控及简短固件版本，不加载更新模块。设置页默认打开外观标签，切入版本标签才读取包与版本；GitHub 检查仍需手动点击，不自动升级。登录页保留只含外观控制的弹窗。

组件升级：检查结果匹配本机 target 和 OpenWrt 版本后，展开三个 APK 的文件条目查看下载链接和 SHA256，再通过「管理 Zen 软件包」进入 OpenWrt 原生软件包页面上传安装。也可以在该页面刷新软件源、安装软件源提供的 Zen 版本。三个包版本不一致会显示提示。页面没有授予安装权限、自动修改软件源或绕过依赖/签名校验；发布 APK 必须满足设备现有信任和依赖配置。

固件升级：检查结果匹配设备 target/profile 后提供可刷写镜像。R5C 使用 sysupgrade 镜像，x86 使用 combined/combined-efi 镜像，选择与当前文件系统和启动方式一致的文件。通过「备份 / 升级固件」进入原生页面，执行备份、上传、镜像校验、保留配置选择和最终确认。下载 SHA256 展示的是发布信息；刷写前的实际镜像校验由 OpenWrt 执行。

没有权限或未安装原生页面时隐藏对应入口；只读账号的入口标为「只读」，写入仍由 OpenWrt 原有 ACL 控制。页面只新增 `luci.getVersion`、固定的 `package-manager-call list-installed`、包数据库及固件标识的读取权限。包数据库回退使用 CGI 直接读取，避免 ubus 大消息截断。

## 版本和发布信息来源

- 三个 Zen 包：优先用 OpenWrt 原生软件包管理 helper 读取安装记录；兼容 APK JSON、APK 数据库和 opkg status。失败显示「无法读取」，可读数据库内缺少包才显示「未安装」。守护进程的 Cargo 版本只用于发现运行版本漂移，不替代包的 `-rN` 修订号。
- 固件和内核：`system.board`；LuCI：`luci.getVersion`。
- 10Wrt 构建：`/usr/share/10wrt/release.json`。此路径不属于通常保留的 `/etc` 配置，刷新固件后由新镜像提供。旧固件没有这个文件时仍显示 OpenWrt 版本，但不能判断当前 10Wrt 构建是否最新。

Zen 发布工作流运行 `tools/make-release-metadata.py`，从三个 Makefile 的版本/修订号匹配真实 APK 文件并计算 SHA256，产出 `zen-update.json` 并把同一 JSON 放入发布正文的 `<!-- zen-update-metadata ... -->`。三个版本不同、缺包、重复包或空文件会终止发布。

10Wrt `dev/zen` 的构建流程在编译前运行 `scripts/firmware-update-metadata.py stamp`，将 tag、target、profile、run number 和配置提交写入固件覆盖层。编译后 `release` 从 OpenWrt `profiles.json` 选择同一 profile 的可刷写镜像，并验证其文件大小及 SHA256，生成 `10wrt-update.json` 和正文标记 `<!-- 10wrt-update-metadata ... -->`。安装标识与发布 tag 使用同一个构建前计算的值，避免跨日构建不一致。

浏览器从 GitHub API 的发布正文读取元数据，避免跨域读取 release 附件失败。元数据必须与正式发布 tag、仓库和已上传附件名称/大小匹配；API 提供附件 digest 时也必须一致。代码按数值比较包版本和修订号，固件按同 profile 的构建号比较。未知版本格式、最新发布缺少有效元数据、目标不匹配、断网、15 秒超时或限流均不会显示「已是最新」。检查范围是最近 100 个发布，预发布不计入正式更新。

## 验证

`node tools/test-zen-updates.cjs` 和 `python tools/test-release-metadata.py` 验证解析、比较、兼容性及发布元数据；10Wrt 的 `python scripts/test-firmware-update-metadata.py` 验证 R5C/x86 镜像筛选与损坏检测。可选的 `tools/test-zen-settings-browser.cjs` 验证真实入口、100 组外观/布局/明暗/屏宽组合、键盘标签、延迟版本读取、刷新及登录页回退；`tools/test-zen-updates-browser.cjs` 使用真实 LuCI 模块和只读 RPC/GitHub fixtures，检查 200 组配色、质感、布局、屏宽和明暗状态，以及权限、故障回退及零写入。

本地预览的软件包/固件链接显示入口占位；实际原生流程需要在 OpenWrt 上验收。历史发布没有结构化更新信息时不会猜测兼容性，下一次包含上述元数据的正式构建才提供完整比较。
