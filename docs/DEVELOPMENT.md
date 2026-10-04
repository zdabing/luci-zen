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

Sunny UI 的原始材质文件为 `luci-theme-zen/htdocs/luci-static/zen/appearance.css`，
保持上游版本不变；LuCI 映射放在 `appearance-zen.css`，原生偏好、共享表单及登录页弹窗代码在
`appearance.js`。出处和许可见主题目录的 `THIRD_PARTY_NOTICES.md`。
主题不引入 React、npm 运行时或新的后端接口。
静态文件使用固件原生 Web 服务，安装不注册 `uhttpd.ucode_prefix` 缓存处理器；
从旧版升级时仅清理旧 Zen 自己注册的前缀。已有主题选择保持不变。

首页使用独立菜单路由 `admin/zen`（`root/usr/share/luci/menu.d/luci-theme-zen.json`），
由 `view/zen/home.js` 按 LuCI 视图生命周期挂载，`dashboard.js` 仅提供数据和组件，
导入时不操作 DOM 或启动轮询。菜单排序在标准「状态」之前；管理入口首个可用页面
及 Logo 指向 Zen 首页。原生 `admin/status/overview` 保留原 action、权限和内容，
Zen 菜单中显示为「OpenWrt 概览」，不再在它前面插入仪表盘。
实现对应 [LuCI 25.12 菜单入口](https://github.com/openwrt/luci/blob/openwrt-25.12/modules/luci-base/root/usr/share/luci/menu.d/luci-base.json)
和 [标准视图生命周期](https://github.com/openwrt/luci/blob/openwrt-25.12/modules/luci-base/htdocs/luci-static/resources/luci.js)。

管理页右上角「Zen 设置」进入独立 `admin/system/zen` 页面，系统菜单也提供同一入口。外观/布局标签复用 `ZenAppearance.render()`，版本/更新标签按需挂载 `zen-updates.js`；首页不加载该模块。登录页仍提供外观弹窗，右上角深浅色快捷切换保持独立。默认马卡龙＋iOS 玻璃，明暗默认跟随系统；
保留既有 `luci-theme-zen` 明暗存储键，新增 `luci-theme-zen-accent` 和
`luci-theme-zen-material` 和 `luci-theme-zen-layout`。四个选择互相独立，五个预设只同时调整配色与材质。
布局默认 `sidebar`（左侧导航），另可选择 `top`（顶部导航）。顶部布局在桌面
复用 LuCI 菜单树显示横向分类及点击展开的子菜单，内容使用全部可用宽度；
手机仍显示折叠菜单。布局不会覆盖独立的 `luci-theme-zen-sidebar` 收起偏好。
未知值回退默认方案，存储不可用时仍可在当前会话切换。

从仓库根目录启动：

```sh
python -m http.server 8770 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8770/dev-preview/runtime.html?page=dashboard`。
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
Windows 未安装 GNU make 时，安装资产检查可把 `ZEN_TEST_BASH` 设为 Git Bash 的
绝对路径，再运行 `python tools/test-package-assets.py`；测试仍执行包中的原安装配方。

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
`openwrt-sdk-*.tar.zst`（CI 默认 25.12.5，x86/64）；若编译含 eBPF 的包，还需同目录的
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
- `build.yml`：tag（`v*`）/ release / 手动触发 → OpenWrt 25 SDK 编译三个包（luci-theme-zen、
  zen-traffic、luci-app-zen-traffic），只打 `.apk` 上传 artifacts（release 事件附加到 Release）。
  当前仅 x86_64（`x86/64`）目标，扩展其它架构时在 build.yml 增加 matrix。
