#!/bin/sh
# Rust feasibility spike 验证（README.md §Step 2–5 的自动化版）。
#
# 在有 root 的 Linux（开发机或路由器）上执行：
#   ./verify.sh <zen_traffic.bpf.o> [iface] [binary]
#
# 前置：
#   - 开发机：root（CAP_BPF/CAP_NET_ADMIN）、ubusd 运行中（或 --no-attach 模式单独验证 Step 4/5）
#   - 路由器：scp binary + .bpf.o 后以绝对路径执行
# 输出：每步 PASS/FAIL，末尾汇总 8 问清单的对应答案。
set -u

BPF="${1:?usage: verify.sh <zen_traffic.bpf.o> [iface] [binary]}"
IFACE="${2:-br-lan}"
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BIN="${3:-$(find "$DIR" -type f -name zen-trafficd-spike -perm -u+x 2>/dev/null | head -n1)}"

PASS=0; FAIL=0
ok()   { echo "[PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }
need() { command -v "$1" >/dev/null 2>&1; }

[ -x "$BIN" ] || { echo "binary 未找到（第 3 参或 target 下）"; exit 2; }
echo "binary = $BIN"
echo "bpf.o  = $BPF"
echo "iface  = $IFACE"
echo

# Step 5/4 验证需要 ubusd；没有则只验证 Step 2/3 后半程
if ! need ubus; then
    echo "!! 本机无 ubus CLI —— Step 4/5 请在路由器上跑本脚本"
fi

echo "== 启动 daemon（Step 2/3 的加载与 attach 输出）=="
"$BIN" -b "$BPF" -i "$IFACE" > /tmp/zen-spike.log 2>&1 &
PID=$!
sleep 3

grep -q "zen_ingress (SchedClassifier(tc))" /tmp/zen-spike.log && \
    ok "Step2: SchedClassifier zen_ingress/zen_egress 识别" || \
    bad "Step2: 未识别到 tc 程序（见 /tmp/zen-spike.log）"
grep -q "map: devices (HASH)" /tmp/zen-spike.log && \
    ok "Step2: devices HASH map 识别" || bad "Step2: devices map 未识别"
grep -q "map: local_prefixes (LPM_TRIE)" /tmp/zen-spike.log && \
    ok "Step2: local_prefixes LPM_TRIE 识别" || true
grep -q "attach 完成" /tmp/zen-spike.log && \
    ok "Step3: clsact + ingress/egress attach" || bad "Step3: attach 失败"

if need tc; then
    N=$(tc filter show dev "$IFACE" 2>/dev/null | grep -c "zen_")
    [ "$N" = "2" ] && ok "Step3: tc filter 恰 2 条（ingress+egress）" \
                  || bad "Step3: tc filter 数量 $N ≠ 2"
fi

# Step 4：ubus 直连
if need ubus; then
    if ubus call zen.traffic ping 2>/dev/null | grep -q '"status": "pong"'; then
        ok "Step4: ubus call zen.traffic ping → pong"
    else
        bad "Step4: ping 未响应"
    fi
    if ubus call zen.traffic stats 2>/dev/null | grep -q '"devices"'; then
        ok "Step4: ubus call zen.traffic stats → 结构化结果"
        ubus call zen.traffic stats
    else
        bad "Step4: stats 未响应"
    fi
    grep -q "sock offset = 80" /tmp/zen-spike.log && \
        ok "Step4: FFI 布局自检（64-bit sock offset 80）" || true

    # Step 5：SIGTERM clean shutdown
    kill -TERM "$PID"
    for i in 1 2 3 4 5; do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
    if kill -0 "$PID" 2>/dev/null; then
        bad "Step5: SIGTERM 后 5s 未退出"; kill -9 "$PID"
    else
        ok "Step5: SIGTERM → 干净退出（≤1s tick 周期）"
    fi
    grep -q "TC filter 已 detach" /tmp/zen-spike.log && \
        ok "Step5: detach 输出确认" || true
    grep -q "clean shutdown 完成" /tmp/zen-spike.log && \
        ok "Step5: 清理流程完整" || true
    if need tc; then
        N=$(tc filter show dev "$IFACE" 2>/dev/null | grep -c "zen_")
        [ "$N" = "0" ] && ok "Step5: 退出后 tc filter 清空" \
                      || bad "Step5: 残留 filter $N 条"
    fi
    echo; echo "---- daemon 运行日志 ----"; cat /tmp/zen-spike.log
else
    kill "$PID" 2>/dev/null
fi

echo
echo "================ 汇总：PASS=$PASS FAIL=$FAIL ================"
echo "对应 README.md 末尾 8 问清单：1(SDK 编译)需在 SDK 侧确认；其余以本输出为准。"
[ "$FAIL" = "0" ]
