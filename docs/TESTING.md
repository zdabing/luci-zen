# 测试

## CI 层（每次 push / PR）

`.github/workflows/ci.yml` 自动执行：

1. `cargo check --workspace`（`zen-traffic/`）
2. eBPF 对象编译：`clang -target bpf` 编译 `zen-traffic/bpf/zen_traffic.bpf.c`
3. `.po` 翻译文件校验：`node tools/check-po.js`

## SDK 构建层（tag / release）

`build.yml` 在 OpenWrt SDK 内实际编译 `luci-theme-zen`、`zen-traffic` 与 `luci-app-zen-traffic`，
验证包 Makefile、交叉工具链与依赖元数据；产物 `.apk` 上传为 artifacts。

## 真机验收

数据面行为基线 A–H 的完整判据、环境变量与运行方式见
[poc/README.md §5](../poc/README.md)。要点：

| # | 验证 | 判据摘要 |
|---|---|---|
| A | Ethernet IPv4 上/下行 | 方向正确，量级与 iperf3 一致（±10%） |
| B | IPv6 上/下行 | 归并到同一 MAC 条目 |
| C | Wi-Fi 设备 | 计数 ≈ iperf3 实际字节 0.9~1.3 倍，无双计 |
| D | MAC 归因 | 非流量主机条目增量 < 10% |
| E | 局域网对传 | 不计 WAN |
| F | 多设备并发 | 条目独立正确 |
| G | 重启清理/恢复 | `-p` 计数连续，tc filter 无重复累积 |
| H | SW offload 误差 | OFF/ON 各测一次，结论写回 ARCHITECTURE.md |

已知口径与边界（L3 字节口径、软/硬件分载可见性、组播不计数、
eBPF atomics 内核版本要求）见 [poc/README.md §6](../poc/README.md)。

## 主题浏览器验收

- `dev-preview/index.html` 本地预览明暗两套配色与 Dashboard 布局；
- 真机安装后回归：登录页、概览仪表、菜单树、移动端断点、
  `prefers-reduced-motion` 生效、zh-cn 翻译加载（`.lmo` 存在时）。
