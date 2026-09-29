# luci-zen

自包含的 OpenWrt / ImmortalWrt LuCI 项目：Apple 风格主题 + 设备实时流量统计。
目标平台：OpenWrt 25.x（ucode + 原生 JS，无 Lua 运行时）。

## 组成

| 目录 | 说明 | 产物 |
| --- | --- | --- |
| `luci-theme-zen/` | LuCI 主题：概览 Dashboard、明暗双色、Reduced-motion 适配 | `luci-theme-zen_*.apk`（arch: all） |
| `luci-app-zen-traffic/` | 设备流量 LuCI 页面：实时速率、日/月用量、历史记录 | `luci-app-zen-traffic_*.apk`（arch: all） |
| `zen-traffic/` | 流量统计后台：eBPF TC 数据面 + Rust/Aya 守护进程 + ubus + SQLite | `zen-traffic_*.apk`（按目标架构交叉编译） |
| `poc/` | 实验性 PoC（eBPF C 原型、Rust spike），行为基线 A–H 的出处 | 不出包 |
| `docs/` | 架构、开发、测试文档 | — |
| `tools/` | 开发辅助脚本（如 .po 校验） | — |
| `dev-preview/` | 浏览器主题预览页（脱机设计稿） | — |

`luci-theme-zen` 运行时探测 ubus 对象 `zen.traffic`，设备流量模块在守护进程存在时自动启用，二者无硬依赖；
`luci-app-zen-traffic` 提供完整的设备流量页面，硬依赖 `zen-traffic`。

## 快速开始

主题开发预览：浏览器打开 `dev-preview/index.html`。

SDK 编译（GitHub Actions 自动完成，本地手动流程见 `docs/DEVELOPMENT.md`）：

- push / PR → CI：Rust `cargo check` + eBPF 对象编译 + `.po` 校验
- 手动运行 SDK Build → 编译成功后把三个 `.apk` 上传到 Artifacts，并创建一个标记 SDK 目标的预发布 Release
- 打 `v*` tag → 编译成功后把三个 `.apk` 上传到正式 Release

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 总体架构、数据面设计、发布计划
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — 本地开发与 SDK 编译
- [docs/TESTING.md](docs/TESTING.md) — 真机测试基线与回归项
- [poc/README.md](poc/README.md) — PoC 验证步骤与结论

## 许可证

按组件划分：`zen-traffic/` 与仓库级默认许可为 **GPL-2.0**（见 [LICENSE](LICENSE)）；
`luci-theme-zen/` 为 **Apache-2.0**（见 [luci-theme-zen/LICENSE](luci-theme-zen/LICENSE)）。
