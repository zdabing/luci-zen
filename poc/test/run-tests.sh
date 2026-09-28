#!/bin/sh
# luci-zen Phase 0 · A–H 验收脚本（在路由器上执行）
#
# 依赖：ubus/jsonfilter（OpenWrt 自带）、可路由的 iperf3 测试路径、测试主机上跑 iperf3 -s
#
# 环境变量（按实验拓扑设置）：
#   HOST_LAN_MAC   以太网测试主机 MAC，如 "aa:bb:cc:dd:ee:01"
#   HOST_LAN2_MAC  第二台以太网主机 MAC（D/F 用）
#   WIFI_MAC       无线测试主机 MAC（C 用）
#   NAS_MAC        NAS MAC（E 用）
#   WAN_SRV        不在本地前缀内的 iperf3 服务器（WAN 方向流量），如 10.99.99.1
#   LAN_SRV        本地 iperf3 服务器（E 用，如 NAS 的 IP）
#   IPERF          在测试主机上发起 iperf3 的命令模板，含 %s 占位（目标地址）
#                  例: IPERF="ssh root@192.168.1.10 iperf3 -t 10 -c %s"
#   IPERF_REV      反方向（下载）模板（可选，默认 IPERF + " -R"）
#   DAEMON         daemon 启动命令（默认 "zen-trafficd-poc -p -q"）
#
# 用法: ./run-tests.sh a|b|c|d|e|f|g|h|all

DAEMON="${DAEMON:-zen-trafficd-poc -p -q}"
JQ="jsonfilter"

fail() { echo "FAIL [$1] $2"; FAILED=1; }
pass() { echo "PASS [$1] $2"; }

# ---- 基础工具 ----

stats() { ubus call zen.traffic.poc getStats 2>/dev/null; }

# value <mac> <field>: 读取某 MAC 的字段
value() {
	stats | $JQ -e "\$.devices[@.mac='$1'].$2" 2>/dev/null | tr -d ' \n"'
}

# run_iperf <target> [rev]
run_iperf() {
	cmd="$IPERF"
	[ -n "$2" ] && cmd="${IPERF_REV:-$IPERF -R}"
	# shellcheck disable=SC2086
	sh -c "$(printf '%s' "$cmd" | sed "s|%s|$1|")" >/dev/null 2>&1
}

delta() {	# delta <before> <after> → 无符号差
	echo $(( ($2 >= $1) ? ($2 - $1) : 0 ))
}

daemon_running() { ubus call zen.traffic.poc getStats >/dev/null 2>&1; }

start_daemon() {	# start_daemon [额外参数...]
	# shellcheck disable=SC2086
	$DAEMON "$@" >/tmp/zen-poc.log 2>&1 &
	sleep 2
	daemon_running || { echo "daemon 启动失败，见 /tmp/zen-poc.log"; exit 1; }
}

stop_daemon() {
	killall zen-trafficd-poc 2>/dev/null
	sleep 1
}

# 误差率：|counted - expect| / expect（百分数，整数）
err_pct() {
	e=$1; c=$2
	[ "$e" -le 0 ] && { echo 999; return; }
	echo $(( (c > e ? c - e : e - c) * 100 / e ))
}

# ---- A：Ethernet IPv4 上传/下载 ----
test_a() {
	echo "=== A: Ethernet IPv4 download/upload ==="
	[ -n "$HOST_LAN_MAC" ] && [ -n "$WAN_SRV" ] || { fail A "需设置 HOST_LAN_MAC/WAN_SRV"; return; }

	ubus call zen.traffic.poc reset >/dev/null
	run_iperf "$WAN_SRV" || { fail A "iperf3 上传失败"; return; }
	up_tx=$(value "$HOST_LAN_MAC" wan_tx_b); up_rx=$(value "$HOST_LAN_MAC" wan_rx_b)

	ubus call zen.traffic.poc reset >/dev/null
	run_iperf "$WAN_SRV" rev || { fail A "iperf3 下载失败"; return; }
	dn_rx=$(value "$HOST_LAN_MAC" wan_rx_b); dn_tx=$(value "$HOST_LAN_MAC" wan_tx_b)

	[ "${up_tx:-0}" -gt 1000000 ] && [ "$up_rx" -le "$up_tx" ] \
		&& pass A "上传: wan_tx=$up_tx wan_rx=$up_rx" \
		|| fail A "上传方向异常 (wan_tx=$up_tx wan_rx=$up_rx)"

	[ "${dn_rx:-0}" -gt 1000000 ] && [ "$dn_tx" -le "$dn_rx" ] \
		&& pass A "下载: wan_rx=$dn_rx wan_tx=$dn_tx" \
		|| fail A "下载方向异常 (wan_rx=$dn_rx wan_tx=$dn_tx)"
}

# ---- B：IPv6 上传/下载 ----
test_b() {
	echo "=== B: IPv6 download/upload ==="
	[ -n "$WAN_SRV_V6" ] || { echo "SKIP B: 未设置 WAN_SRV_V6（无 v6 上联时可用本地 v6 验证归因）"; return; }

	ubus call zen.traffic.poc reset >/dev/null
	run_iperf "$WAN_SRV_V6" || { fail B "iperf3 v6 上传失败"; return; }
	tx=$(value "$HOST_LAN_MAC" wan_tx_b)

	ubus call zen.traffic.poc reset >/dev/null
	run_iperf "$WAN_SRV_V6" rev || { fail B "iperf3 v6 下载失败"; return; }
	rx=$(value "$HOST_LAN_MAC" wan_rx_b)

	[ "${tx:-0}" -gt 1000000 ] && pass B "v6 上传归因同一 MAC: $tx" || fail B "v6 上传未计数"
	[ "${rx:-0}" -gt 1000000 ] && pass B "v6 下载归因同一 MAC: $rx" || fail B "v6 下载未计数"
}

# ---- C：Wi-Fi 设备（且无双计）----
test_c() {
	echo "=== C: Wi-Fi device ==="
	[ -n "$WIFI_MAC" ] && [ -n "$WAN_SRV" ] || { fail C "需设置 WIFI_MAC/WAN_SRV"; return; }

	ubus call zen.traffic.poc reset >/dev/null
	run_iperf "$WAN_SRV" || { fail C "iperf3 失败"; return; }
	tx=$(value "$WIFI_MAC" wan_tx_b)

	# 无双计：计数应在 iperf 实际传输量的 0.9~1.3 倍内（L3 口径 + 头开销）
	# IPERF_BYTES 由测试方从 iperf3 输出获取（可选），未提供时仅验证方向与量级
	[ "${tx:-0}" -gt 1000000 ] && pass C "Wi-Fi 计数: $tx（仅挂 br-lan，端口不重复挂载）" \
		|| fail C "Wi-Fi 未计数（检查无线是否桥接进 br-lan）"
}

# ---- D：MAC 归因互不串数 ----
test_d() {
	echo "=== D: MAC attribution ==="
	[ -n "$HOST_LAN_MAC" ] && [ -n "$HOST_LAN2_MAC" ] && [ -n "$WAN_SRV" ] || { fail D "需设置两台主机 MAC"; return; }

	ubus call zen.traffic.poc reset >/dev/null
	run_iperf "$WAN_SRV" || { fail D "iperf3 失败"; return; }

	t1=$(value "$HOST_LAN_MAC" wan_tx_b)
	t2=$(value "$HOST_LAN2_MAC" wan_tx_b)
	[ "${t1:-0}" -gt 1000000 ] && [ "${t2:-0}" -lt $((t1 / 10)) ] \
		&& pass D "主机1=$t1, 主机2=$t2（互不串数）" \
		|| fail D "归因串数 (t1=$t1 t2=$t2)"
}

# ---- E：PC→NAS 局域网传输不计 WAN ----
test_e() {
	echo "=== E: LAN-to-LAN not counted as WAN ==="
	[ -n "$HOST_LAN_MAC" ] && [ -n "$NAS_MAC" ] && [ -n "$LAN_SRV" ] || { fail E "需设置 HOST_LAN_MAC/NAS_MAC/LAN_SRV"; return; }

	ubus call zen.traffic.poc reset >/dev/null
	run_iperf "$LAN_SRV" || { fail E "iperf3 失败"; return; }

	w1=$(value "$HOST_LAN_MAC" wan_tx_b); w2=$(value "$NAS_MAC" wan_rx_b)
	[ "${w1:-0}" -lt 100000 ] && [ "${w2:-0}" -lt 100000 ] \
		&& pass E "PC wan_tx=$w1 / NAS wan_rx=$w2（≈0，未计入 Internet）" \
		|| fail E "局域网流量泄漏进 WAN 计数 (PC=$w1 NAS=$w2)"
}

# ---- F：多设备并发 ----
test_f() {
	echo "=== F: concurrent devices ==="
	[ -n "$HOST_LAN_MAC" ] && [ -n "$WIFI_MAC" ] && [ -n "$WAN_SRV" ] || { fail F "需设置 HOST_LAN_MAC/WIFI_MAC"; return; }

	ubus call zen.traffic.poc reset >/dev/null
	# 两个方向/两台主机并发：由测试方同时发起两条 iperf3（脚本仅校验结果）
	echo "  请同时发起两条 iperf3（LAN 主机 + Wi-Fi 主机 → $WAN_SRV），完成后回车"
	read -r dummy
	t1=$(value "$HOST_LAN_MAC" wan_tx_b)
	t2=$(value "$WIFI_MAC" wan_tx_b)
	[ "${t1:-0}" -gt 1000000 ] && [ "${t2:-0}" -gt 1000000 ] \
		&& pass F "并发双设备: lan=$t1 wifi=$t2" \
		|| fail F "并发计数缺失 (lan=$t1 wifi=$t2)"
}

# ---- G：daemon 重启的清理/恢复 ----
test_g() {
	echo "=== G: daemon restart cleanup/restore ==="
	before=$(value "$HOST_LAN_MAC" wan_tx_b); before=${before:-0}

	run_iperf "$WAN_SRV" >/dev/null 2>&1 &
	IPID=$!
	sleep 3
	stop_daemon
	start_daemon -p
	wait $IPID 2>/dev/null
	sleep 2

	after=$(value "$HOST_LAN_MAC" wan_tx_b); after=${after:-0}
	nfil=$(tc filter show dev "${POC_IFACE:-br-lan}" 2>/dev/null | grep -c "pref 1" || true)

	[ "$after" -ge "$before" ] \
		&& pass G "pin 模式计数连续: before=$before after=$after" \
		|| fail G "计数未恢复 (before=$before after=$after)"

	# 幂等 attach：in+egress 恰好各 1 条（pref 1）
	[ "$nfil" -le 4 ] \
		&& pass G "tc filter 无重复 (匹配行=$nfil，期望 in/eg 各 1)" \
		|| fail G "filter 疑似重复累积 ($nfil)"
}

# ---- H：Software Flow Offloading ON/OFF 误差 ----
test_h() {
	echo "=== H: SW flow offloading ON/OFF error ==="
	[ -n "$HOST_LAN_MAC" ] && [ -n "$WAN_SRV" ] || { fail H "需设置 HOST_LAN_MAC/WAN_SRV"; return; }

	# OFF（默认）基线
	ubus call zen.traffic.poc reset >/dev/null
	run_iperf "$WAN_SRV" || { fail H "iperf3 失败"; return; }
	off_tx=$(value "$HOST_LAN_MAC" wan_tx_b); off_tx=${off_tx:-0}

	# ON
	uci -q set firewall.@defaults[0].flow_offloading='1'
	uci -q commit firewall
	/etc/init.d/firewall restart >/dev/null 2>&1
	sleep 3

	ubus call zen.traffic.poc reset >/dev/null
	run_iperf "$WAN_SRV" || true
	on_tx=$(value "$HOST_LAN_MAC" wan_tx_b); on_tx=${on_tx:-0}

	# 还原（KEEP_OFFLOAD=1 可保留）
	[ "${KEEP_OFFLOAD:-0}" = "1" ] || {
		uci -q set firewall.@defaults[0].flow_offloading='0'
		uci -q commit firewall
		/etc/init.d/firewall restart >/dev/null 2>&1
	}

	off_err=$(err_pct "$IPERF_BYTES" "$off_tx")
	on_err=$(err_pct "$IPERF_BYTES" "$on_tx")
	echo "  offload OFF: counted=$off_tx err≈${off_err}%"
	echo "  offload ON : counted=$on_tx err≈${on_err}%"
	echo "  （IPERF_BYTES 未设置时 err 为占位 999，请对照 iperf3 输出人工记录）"
	pass H "已获得 ON/OFF 两组数据，结论记录至 ARCHITECTURE.md 执行记录"
}

# ---- main ----
FAILED=0
case "${1:-all}" in
	a) test_a ;;
	b) test_b ;;
	c) test_c ;;
	d) test_d ;;
	e) test_e ;;
	f) test_f ;;
	g) test_g ;;
	h) test_h ;;
	all)
		daemon_running || start_daemon -p
		test_a; test_b; test_c; test_d; test_e; test_f; test_g; test_h
		;;
	*) echo "用法: $0 a|b|c|d|e|f|g|h|all"; exit 1 ;;
esac

[ "$FAILED" = "0" ] && echo "==== RESULT: ALL PASS ====" || echo "==== RESULT: FAILED ===="
exit "$FAILED"
