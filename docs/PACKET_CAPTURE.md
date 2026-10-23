# Zen 抓包（Packet Capture）

目标：在路由器上按设备抓包并导出 pcap，用 Wireshark 深度分析；提供域名画像与 Charles 式 HTTP 请求列表；HTTPS 解密作为可选能力放在最后，独立可砍。与 Charles 的关键差异：路由器是网关，天然覆盖所有设备、无需配置系统代理；HTTPS 明文解密则依赖设备信任路由器 CA，且对证书固定（pinning）的 App 永远不可能生效。

## 已拍板的决策

- **抓包进程独立**：`zen-capture` 是与 zen-trafficd 平行的独立守护进程（同一个 OpenWrt 包内的第二个二进制）。抓包是重 CPU/内存操作，崩溃或耗尽资源不得影响流量账本；与主 daemon 只共享 UCI 配置文件与 ACL，无进程内依赖。
- **HTTPS MITM 排最后**（M4，独立可砍）。M1–M3 不要求用户安装任何证书。
- 捕获粒度为**单台设备（MAC）**；不支持无条件全网抓包，避免把抓包变成常驻监听。
- 红线延续：无 HTTP 服务、无 shell 轮询；所有能力经 ubus `zen.capture` 发布。
- **HTTP 代理并入 zen-capture**（而非独立 zen-proxy）：代理只在会话期间监听，会话结束即关闭，与 pcap/域名/事件同属一个会话模型，拆两个进程只会复制限额与会话管理。（M3 修订）

## 能力分档与分期

| 期 | 能力 | 前提 | 状态 |
| --- | --- | --- | --- |
| M1 | 按 MAC 抓包 → pcap 下载（tcpdump） | tcpdump | 已实现 |
| M2 | eBPF tap（默认模式）+ DNS/SNI 域名画像 + 实时页设备入口 | 内核 ≥5.8（ringbuf） | 本文档实现 |
| M3 | HTTP 透明代理 + 实时请求列表 + HAR 基础 | 无 | 本文档实现 |
| M4 | 可选 HTTPS MITM（CA 分发 + rustls + HAR） | 设备安装并信任 CA；pinning 域名直连 | 本文档实现 |

## 会话模型（M2 起）

会话新增字段：`mode`（`tap`：eBPF 抓包，产出 pcap + 域名画像；`http`：透明代理，产出 HTTP/HTTPS 事件与 HAR）、`decrypt`（仅 http 模式，MITM 开关）、`domains`/`events` 计数。限额（时长/并发/保留）对两种模式一致；`max_bytes` 只约束 tap 模式的 pcap 总量，http 模式由时长兜底。

## M2：eBPF tap

```
zen_capture.bpf.o（zen-capture 自有对象，不碰 zen_traffic.bpf.o）
  TC ingress/egress @ LAN 成员口
    capture_enable HASH<mac,u8>   ← start 时写入，stop 时删除
    events RINGBUF(1 MiB)         ← 命中帧：{mac, orig_len, ts, data[256]}
    verdict 恒 TC_ACT_UNSPEC（继续链）
```

- **挂载顺序**：TC 多 filter 链里 `TC_ACT_OK`（TCX 语义下等于 `TCX_PASS`）是终止语义——zen 会计程序恒返回 `TC_ACT_OK`，capture 必须先于它运行。TCX（内核 ≥6.6）：`TcAttachOptions::TcxOrder(LinkOrder::first())` 插到链首；旧内核回落 `TcAttachOptions::Netlink(NlOptions{priority:1,..})`。capture 恒返回 `TC_ACT_UNSPEC`（= `TCX_NEXT` / cls_bpf 继续匹配），会计 filter 照常执行。
- **残留清理**：启动时 `tc::qdisc_detach_program(iface, ty, "zen_cap_*")` 按名清理崩溃残留（TCX link 随进程释放，netlink 路径需显式清理）。
- **pcap 直写**：zen-capture 每 tick 排空 ringbuf，直接追加 pcap 记录（帧时间 = `bpf_ktime_get_ns` + 每 tick 校准的 monotonic→epoch 偏移）；ringbuf 满时丢帧（忙时抓包允许丢帧，pcap 记录 `orig_len` 保证口径可解释）。
- **域名画像（用户态解析，BPF 保持无脑）**：对 ringbuf 帧解析 IPv4/IPv6 → UDP 53 DNS 查询 qname；TCP 443/80 → TLS ClientHello SNI（尽力而为，ClientHello 超出 snaplen 的域不可见）。每会话聚合 `{domain, count, last_ts}`，上限 500 条。
- **回落**：tap 加载/attach 失败返回 `tap_unavailable`，可显式指定 `mode:"tcpdump"` 走 M1 路径（tcpdump 保留为 fallback）。

ubus 增量：`getDomains {id}` → `[{domain, count, last_ts}]`（按次数降序，前 100）。

## M3：HTTP 透明代理（并入 zen-capture）

- **重定向**：`nft` 创建专属表 `inet zen_capture`；每个 http 会话一条独立链 `pre_<id> { type nat hook prerouting priority dstnat; }`，规则 `meta l4proto tcp tcp dport 80 redirect to :<port>`（v4/v6 一条覆盖）。会话结束 `delete chain`，不追踪 rule handle。daemon 启动时整体重建表（清掉崩溃残留）。多会话靠每会话独立监听端口区分来源，无需 MAC 传递。
- **代理**：tokio 运行时跑在后台线程（主线程保持 uloop/ubus）。手写 HTTP/1.1 解析（请求行 + 头，≤32KB，keep-alive 循环），透明转发到 Host:80，记录事件 `{ts, method, host, path, status, req_bytes, resp_bytes}`。每会话保留最近 500 条事件。
- ubus 增量：`getEvents {id}` → 最近事件列表。

## M4：HTTPS MITM（可选，默认关）

- **CA**：首次启用时生成根 CA（rcgen，RSA-2048，CA:TRUE），落 `/etc/zen-capture/ca.pem + ca.key`（0600）；`getCA` 返回证书 PEM 供下载，页面给各平台安装指引。会话 `decrypt:true` 才生效。
- **流程**：redirect 443 → 会话端口；代理先读 ClientHello 提取 SNI → 命中 `decrypt_skip` 名单（uci list，防 pinning 白名单）→ 直接 TCP splice 透传（事件记 `passthrough`）；否则动态签发 leaf（SAN=域名，会话内缓存）→ rustls 终结客户端 TLS（ALPN 仅 http/1.1）→ 上游 rustls TLS（根证书读 `/etc/ssl/certs/ca-certificates.crt`，ca-bundle 依赖已有）→ 解密流上解析 HTTP 头记录事件；上游握手失败（pinning/中间人防护）记 `tls_failed`。
- **QUIC 逼退**：decrypt 会话追加规则 `meta l4proto udp udp dport 443 drop`，浏览器回落 TCP。
- **HAR**：`getHar {id}` 从事件生成 HAR 1.2 JSON（http + 解密 https 条目）。
- 明确不可解：证书固定 App、ECH 加密 SNI。失败一律显式呈现，不静默。

## ubus 契约：对象 `zen.capture`

| 方法 | 入参 | 回包（`json` 字符串字段） | 权限 |
| --- | --- | --- | --- |
| `start` | `{mac, mode?:"tap"\|"http"\|"tcpdump", seconds?, max_bytes?, decrypt?, snap?}` | `{ok:1,session:{…}}`；失败 `{ok:0,error}` | write |
| `stop` | `{id}`（id 或 MAC） | `{ok:1,session:{…}}` | write |
| `status` | – | `{ok:1,sessions:[…],caps:{…},ca_ready:bool}` | read |
| `delete` | `{id}` | `{ok:1}`；running 拒绝 `session_running` | write |
| `getDomains` | `{id}` | `{ok:1,domains:[{domain,count,last_ts}]}`（按次数降序，前 100） | read |
| `getEvents` | `{id}` | `{ok:1,events:[{ts,kind,method,host,path,status,req_bytes,resp_bytes}]}`（最近 500；kind = http/https/passthrough/tls_failed） | read |
| `getCA` | – | `{ok:1,pem:"…"}` | read |
| `getHar` | `{id}` | `{ok:1,har:"<HAR 1.2 JSON>"}` | read |

错误码：`invalid_mac` / `tcpdump_missing` / `too_many_sessions` / `already_capturing` / `spawn_failed` / `session_running` / `not_found` / `tap_unavailable` / `nft_failed` / `ca_unavailable` / `mitm_unavailable`。缺参返回 ubus `INVALID_ARGUMENT`。

## LuCI 页面

- 路由 `admin/zen/capture`（导航第四项「抓包」）。
- 控件：设备选择、模式（抓包 pcap / HTTP 请求）、时长、大小上限、开始；http 模式下可选「解密 HTTPS」（未生成 CA 时提供一键生成 + ca.crt 下载与安装指引）。
- 会话表：设备、开始时间、时长、状态、操作。tap 会话展示域名列表；http 会话展示请求事件流（方法/主机/路径/状态/大小）并提供 pcap 不适用时的 HAR 下载。
- 实时页设备抽屉新增「抓包」动作（`session.access` 探测 `zen.capture` start 权限），跳转抓包页并预选设备。
- 权限：ACL `zen-capture` 组（read：status/getDomains/getEvents/getCA/getHar + 文件 list/read；write：start/stop/delete）。

## 隐私与安全

抓包含敏感明文。默认只抓单台指定设备；UI 全程显著标识；pcap/事件只存 RAM 环形目录，重启即清；CA 私钥 0600 且仅用于签发；解密为显式开关且默认关。

## 验收

- `node tools/test-zen-capture.cjs`：视图行为（模式/解密/域名/事件/HAR/CA）、路由与 ACL、安装配方、init.d/UCI。
- `cargo test -p zen-capture`：MAC 校验、tcpdump/tap 参数、限额钳制、会话状态机、DNS/SNI/HTTP 解析、HAR 生成、CA 存储、会话恢复。
- CI `ebpf-compile`：`zen_capture.bpf.c` 独立编译（与 zen_traffic 同参数）。
- 真机：TCX 插队后会计与策略不受影响（ubus getDevices 增量正确）、tap 丢帧口径、nft 链建立/回收、MITM 与 pinning 直连、pcap/HAR 在工具中打开。
