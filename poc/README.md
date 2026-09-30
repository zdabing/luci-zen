# Phase 0 — eBPF PoC（zen-traffic 数据面验证）

> 目标：在真实路由器上证明 eBPF 数据面正确（A–H 全 PASS），之后才开始 LuCI Theme。
> 架构依据：[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) §3/§7。
> 本阶段**不涉及 UI**。

## 1. 组成

| 文件 | 说明 |
|---|---|
| `bpf/zen_traffic.bpf.c` | TC ingress/egress 程序：MAC 为 key 计数 bytes/packets/last_seen；`local_prefixes` LPM 区分 WAN/LAN-local；只依赖稳定 UAPI，无 CO-RE/内核 BTF 依赖 |
| `src/zen-trafficd-poc.c` | native daemon（C + libbpf + libubus）：netlink 原生 attach（clsact + cls_bpf direct-action）、1s 差分速率、ubus 对象 `zen.traffic.poc`、pin 恢复 |
| `test/run-tests.sh` | A–H 验收脚本（路由器上执行） |
| `Makefile` | 开发机 / SDK 两用构建 |

## 2. 前置条件（路由器）

```sh
# 内核能力（Phase 0 验证点，缺失则该硬件不可行）
zcat /proc/config.gz | grep -E 'CONFIG_BPF_SYSCALL|CONFIG_BPF_JIT'
#   需要 CONFIG_BPF_SYSCALL=y、CONFIG_BPF_JIT=y
# 内核模块：clsact(sch_ingress) 与 cls_bpf
opkg install kmod-sched kmod-sched-bpf        # ImmortalWrt 同名
# bpffs（pin 模式需要；init.d 正式包会自动挂载）
mount | grep bpf || mount -t bpf bpf /sys/fs/bpf
```

推荐测试拓扑：

```
[LAN 主机 A (eth)] ─┐
[LAN 主机 B (eth)] ─┤  br-lan(192.168.1.1/24)
[NAS]              ─┤
[Wi-Fi 主机]        ─┘         路由器（运行 PoC daemon, iperf3 可选）
                                 wan(10.99.99.2/24) ── [WAN 测试机 10.99.99.1] (iperf3 -s)
```

- WAN 测试机用于制造"非本地前缀"的 Internet 方向流量（也可用公网 iperf3 服务器）。
- daemon 启动时经 ubus `network.interface dump` 学本地子网，**自动排除持有默认路由的上游接口**（WAN 网段不算 local）。

## 3. 构建（开发机 Linux）

```sh
# Debian/Ubuntu 示例
apt install clang llvm libbpf-dev libubox-dev
# libubus 无独立 dev 包时，从 OpenWrt staging 取头文件与库：
#   make UBUS_INC=-I<staging>/usr/include UBUS_LIBS=-L<staging>/usr/lib -lubus -lubox

make                                   # 产物: build/zen_traffic.bpf.o + build/zen-trafficd-poc
llvm-objdump -S build/zen_traffic.bpf.o | head   # 目检 BPF 指令
```

OpenWrt SDK（交叉编译，x86_64 之外的架构同理）：

```sh
make CC=$TARGET_CC CLANG=$TARGET_CLANG \
     LINUX_DIR=$LINUX_DIR LINUX_KARCH=$LINUX_KARCH \
     LIBBPF_CFLAGS="-I$STAGING_DIR/usr/include" \
     LIBBPF_LIBS="-L$STAGING_DIR/usr/lib -lbpf -lelf -lz" \
     UBUS_INC="-I$STAGING_DIR/usr/include" \
     UBUS_LIBS="-L$STAGING_DIR/usr/lib -lubus -lubox"
```

> 说明：BPF 程序按目标内核 UAPI 头编译；产物不含 CO-RE，**不要求目标内核开启
> CONFIG_DEBUG_INFO_BTF**（对象内 BTF 仅为 BTF-defined maps，随 .o 加载）。

## 4. 部署与运行（路由器）

```sh
scp build/zen-trafficd-poc build/zen_traffic.bpf.o root@192.168.1.1:/tmp/
ssh root@192.168.1.1
/tmp/zen-trafficd-poc -b /tmp/zen_traffic.bpf.o -p        # -p: pin maps（G 项需要）
# 观察实时速率（每秒输出活跃设备）:
#   aa:bb:cc:dd:ee:01  WAN↓ 94.1 MB/s  WAN↑ 1.2 MB/s  LAN↓ 0.0 B/s  LAN↑ 0.0 B/s
ubus call zen.traffic.poc getStats        # JSON（测试脚本的数据源）
ubus call zen.traffic.poc reloadPrefixes  # 网络变更后刷新本地前缀
ubus call zen.traffic.poc reset           # 计数清零（测试基线）
# 检查挂载（应恰好 in/egress 各一条，pref 1 handle 1）
tc filter show dev br-lan
```

daemon 重启语义：`-p` 时 maps 复用（计数连续、attach REPLACE 幂等）；不加 `-p` 时计数清零重建；SIGTERM 卸载 filter（仅删除自己创建的 clsact）。

## 5. 验收 A–H（`test/run-tests.sh`）

```sh
chmod +x /tmp/run-tests.sh
export HOST_LAN_MAC="aa:bb:cc:dd:ee:01" HOST_LAN2_MAC="aa:bb:cc:dd:ee:02"
export WIFI_MAC="aa:bb:cc:dd:ee:03" NAS_MAC="aa:bb:cc:dd:ee:04"
export WAN_SRV="10.99.99.1" LAN_SRV="192.168.1.20" WAN_SRV_V6="fd99::1 或公网v6"
export IPERF="ssh root@192.168.1.10 iperf3 -t 10 -c %s"    # 在测试主机发起
export IPERF_BYTES=<iperf3 输出的字节数>                    # 可选，用于误差计算
/tmp/run-tests.sh all
```

| # | 验证 | 判据 |
|---|---|---|
| A | Ethernet IPv4 上/下行 | 该 MAC `wan_tx_b`（上传）/`wan_rx_b`（下载）按方向各自增长，反向计数 ≤ 正向；量级与 iperf3 一致（L3 口径 ±10%） |
| B | IPv6 上/下行 | v6 流量归因到**同一 MAC** 条目，方向正确 |
| C | Wi-Fi 设备 | 无线主机速率/方向正确；计数 ≈ iperf3 实际字节的 0.9~1.3 倍（**无双计**：只挂 br-lan，端口不重复挂） |
| D | MAC 归因 | 主机 A 跑流，B 的条目增量 < A 的 10% |
| E | PC→NAS 不计 WAN | 局域网对传后双方 `wan_*` 增量 < 100KB（桥接直转甚至不产生条目；跨 VLAN 路由场景计入 `lan_*`） |
| F | 多设备并发 | 两台主机同时各跑一条流，条目独立正确 |
| G | 重启清理/恢复 | `-p` 重启后计数连续（after ≥ before）；`tc filter show` 恒为 in/eg 各 1 条，无重复累积 |
| H | SW offload 误差 | OFF/ON 各跑一次 A，记录两组误差率（`IPERF_BYTES` 提供后自动算）；结论写回 ARCHITECTURE.md 执行记录 |

## 6. 已知口径与边界（如实记录）

1. **字节口径**：`skb->len` 为 L3 字节（不含以太网头 14B，GSO skb 已含聚合总长）；与 iperf3 应用层字节存在 3~8% 系统性正差（IP/TCP 头），判据按 ±10% 设线。
2. **软分载（H）**：挂点在 LAN L2，位于 fastpath 判定的路径上——预期**下行仍被计数**；上行是否被 fw4 flowtable（devices 列表含 LAN 设备时）截流由 H 实测给出。硬件分载（包不过 CPU）任何软件方案均不可见，正式 UI 将明示。
3. **组播/广播/ARP** 不计数（控制面噪声）；分片非首包仍计数（scope 只需 IP 头）。
4. **eBPF atomics**（`__sync_fetch_and_add`）需内核 ≥5.2；个别 32 位 MIPS JIT 不支持时 Phase B 提供 spin_lock 变体。
5. PoC 的速率基于 1s 差分；今日/月累计、持久化、DHCP/neighbour/hostapd 属性合并在正式包（Phase B）实现。

## 7. 故障排查

| 现象 | 处理 |
|---|---|
| `bpf_object__load` 失败 | 查内核 BPF_SYSCALL/JIT；`dmesg | tail` 看 verifier 拒绝原因 |
| 无任何设备条目 | 确认挂载接口正确（`tc filter show dev br-lan`）；确认流量走该桥（WiFi 未桥接时需 `-i` 指定） |
| 全都计成 LAN | `ubus call network.interface dump` 确认子网收集；必要时 `-P` 手工补前缀 |
| `-p` 启动报 pin 失败 | `mount -t bpf bpf /sys/fs/bpf` |
