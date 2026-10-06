# Zen APK 安装与发布

保留 eBPF。Rust、LLVM 和 SDK 只运行在构建端，路由器安装预编译 APK。

## 用户安装

提供两个入口：`luci-theme-zen` 为独立主题；`zen-full` 为主题和设备流量整套安装入口。
`zen-full` 依赖三个功能包，后台继续声明 `kmod-sched-bpf`、`kmod-sched-core` 和共享库依赖。
包管理器在同一个安装事务内解决依赖，安装脚本不嵌套调用包管理器。

签名源按 **OpenWrt 发布版本 + target/subtarget** 分开，例如：

```text
https://github.com/zdabing/luci-zen/releases/download/feed-openwrt-25.12.5-rockchip-armv8/packages.adb
```

先确认维护者已发布对应的 feed Release。这个地址格式本身不代表仓库已经上线。
下载该 Release 的 `zen-repository.pem` 和 `install-zen.sh`，从发布说明核对公钥 SHA256。
将文件放到路由器 `/tmp` 后执行（替换公钥指纹）：

```sh
sh /tmp/install-zen.sh /tmp/zen-repository.pem PUBLIC_KEY_SHA256 full
# 只安装主题：把 full 换成 theme。
```

安装工具识别官方 OpenWrt 版本与目标，保留现有固件软件源，配置 Zen 专用软件源。
先模拟安装，只有依赖能够解决才执行安装；整套安装还会启动流量服务并检查状态。
安装主题后，在 LuCI「系统 → 系统 → 语言和界面」选择 Zen。
后续更新可在 LuCI 软件包管理中执行，或者只更新 Zen 包：

```sh
apk update
apk add --upgrade luci-theme-zen luci-app-zen-traffic zen-traffic zen-full
```

此工具不会自动替换内核或把官方 OpenWrt 的源配置到 ImmortalWrt / 自编译固件。
只使用主题的用户也可以继续单独上传主题 APK。

## 维护者发布

1. 在仓库外生成一次持久的 NIST P-256 私钥，安全备份。不要将私钥加入 Git 或构建产物：

   ```sh
   umask 077
   openssl ecparam -name prime256v1 -genkey -noout -out zen-apk-private.pem
   ```

2. 将 PEM 内容配置为仓库 Actions Secret：`ZEN_APK_SIGNING_KEY`。
3. 手动运行 `SDK Build`，选择支持的 SDK 版本和目标，启用 `publish_repository`。
   普通 APK 构建不需要该 Secret。
4. 构建使用同一个 SDK 编译四个包，并使用 SDK 自带 APK 工具签署包和 `packages.adb`。
   发布前验证签名；签名失败、包缺失时不发布软件源。
5. 每次构建 APK 保存在独立的 `feed-build-*` Release；固定 `feed-openwrt-*` 地址只更新索引。
   旧索引引用的 APK 保持可下载。不要删除仍被使用的构建 Release。
   并发发布按软件源串行执行，版本检查拒绝回退，公钥变化要求显式轮换。

feed Release 标记为 prerelease，避免干扰更新页面对正式功能包的选择。
签名源的公钥只需信任一次；不会在用户设备上使用 `--allow-untrusted` 安装。
SDK 生成索引时的 `--allow-untrusted` 仅用于构建阶段，输出随后执行签名验证。

## 后台兼容性

原生后台按目标架构和用户态 ABI 构建，不按路由器型号逐个构建。
内核模块仍由与固件匹配的软件源提供；ABI 不匹配时由 APK 拒绝安装。
保留每个后台的 SDK 来源，额外通过发布元数据 `compatible_systems` 列出实际验证过的系统：

```sh
python3 tools/make-release-metadata.py --assets out --target rockchip/armv8 \
  --sdk-version 25.12.5 --tag YOUR_TAG --notes release-notes.md \
  --compatible-system OpenWrt@25.12.5 \
  --compatible-system ImmortalWrt@25.12-SNAPSHOT
```

后一个系统只能在该 APK 完成加载、接口挂载、下载计数和加速路径验收后添加。
不要仅凭 CPU 架构相同或版本前缀相同声明兼容。
普通 CLI 生成元数据默认只声明构建用的 OpenWrt SDK 版本，不推断其他系统。
同名 Snapshot 不同构建之间还必须单独验证共享库 ABI 和内核能力；此列表不能替代 APK 依赖检查。

后台诊断命令：

```sh
/usr/libexec/zen-traffic-check
ubus call zen.traffic getStatus
logread -e zen-traffic
```

启动前检查模块安装记录、BPF 文件系统支持和后台动态链接能力；BPF 加载和挂载仍由后台执行。
服务响应成功不等于统计准确，验收必须包括真实传输量和开启加速时的测试。

## 10Wrt 自编译固件

main（ImmortalWrt）和 openwrt 两个分支都明确内置两个模块及后台。
defconfig 后检查选包；构建后检查实际内核配置的 BPF syscall、JIT、TC classifier/action 能力。
缺少能力或配套 APK 时，构建不进入发布。

每个固件同时发布 `zen-support.tar.gz` 和 `zen-support.json`，保存该次构建的：

- 完整 target APK 仓库和原始 `packages.adb`，用于保留匹配的内核模块及其目标依赖；
- 固件已信任的 APK 公钥；
- 三个 Zen 功能 APK；
- 固件、内核配置，以及包 SHA256 清单。

模块归档仅供对应固件恢复使用，不能跨固件安装。它不包含所有用户态软件依赖，不宣称完整离线安装包。
10Wrt 已内置模块时，用户无需在后续 Zen 更新时重新获取内核模块。
自编译固件可以使用自身构建的 Zen APK；官方 OpenWrt 签名源不会自动覆盖它。
