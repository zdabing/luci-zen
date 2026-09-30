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
