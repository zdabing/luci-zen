"""Bounded Zen hardware baseline. Password comes from env or an interactive prompt.

pip install paramiko
python tools/router-baseline.py --host 10.0.0.1 --output baseline.json
--transfer uses a temporary HTTP server bound to --client-ip, and a 32 MiB
router RAM file. --restart tests graceful persistence (no router reboot).
These are LAN host-to-router tests, not WAN forwarding or high-PPS tests.
"""
import argparse
import getpass
import json
import math
import os
import shlex
import statistics
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import paramiko


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--host', default='10.0.0.1')
    p.add_argument('--user', default='root')
    p.add_argument('--output', required=True)
    p.add_argument('--samples', type=int, default=15)
    p.add_argument('--transfer', action='store_true')
    p.add_argument('--client-ip')
    p.add_argument('--restart', action='store_true')
    p.add_argument('--host-key-sha256', help='Expected raw host-key SHA256 hex; useful after reflashing')
    a = p.parse_args()
    if not 2 <= a.samples <= 120:
        p.error('--samples must be 2..120')
    if a.transfer and not a.client_ip:
        p.error('--transfer requires --client-ip')
    c = paramiko.SSHClient()
    if not a.host_key_sha256:
        c.load_system_host_keys()
    # Require a known key or an explicitly verified fingerprint.
    class KeyPolicy(paramiko.MissingHostKeyPolicy):
        def missing_host_key(self, client, hostname, key):
            digest = __import__('hashlib').sha256(key.asbytes()).hexdigest()
            if not a.host_key_sha256 or digest != a.host_key_sha256.lower():
                raise paramiko.SSHException('Unknown host key; add it to known_hosts or pass verified --host-key-sha256: ' + digest)
    c.set_missing_host_key_policy(KeyPolicy())
    c.connect(a.host, username=a.user,
              password=os.environ.get('ZEN_ROUTER_PASSWORD') or getpass.getpass('Router password: '),
              timeout=10)
    report = {'host': a.host, 'time_unix': int(time.time()),
              'host_key_sha256_hex': __import__('hashlib').sha256(c.get_transport().get_remote_server_key().asbytes()).hexdigest(),
              'scope': 'LAN host-to-router; background traffic present; no WAN/high-PPS claim'}

    def run(cmd):
        _, out, err = c.exec_command(cmd, timeout=45)
        data = out.read().decode('utf-8', errors='replace')
        errors = err.read().decode('utf-8', errors='replace')
        code = out.channel.recv_exit_status()
        if code:
            raise RuntimeError(f'{cmd}: exit {code}: {errors}')
        return data

    def rpc(method, args=None):
        return json.loads(run('ubus call zen.traffic ' + method + ' ' +
                              shlex.quote(json.dumps(args or {}))))

    def snapshot():
        raw = run("p=$(pidof zen-trafficd); test -n \"$p\" || exit 1; "
                  "cat /proc/$p/stat; head -1 /proc/stat; "
                  "grep -E 'VmRSS|VmHWM' /proc/$p/status; "
                  "grep -c '^processor' /proc/cpuinfo; cat /proc/uptime")
        lines = raw.splitlines()
        fields = lines[0].split(') ', 1)[1].split()
        memory = {line.split(':', 1)[0]: int(line.split()[1]) for line in lines[2:4]}
        return {'pid': int(lines[0].split()[0]), 'ticks': int(fields[11])+int(fields[12]),
                'cpu_ticks': sum(map(int, lines[1].split()[1:9])),
                'rss_kib': memory['VmRSS'], 'hwm_kib': memory['VmHWM'],
                'cores': int(lines[4]), 'uptime': float(lines[5].split()[0])}

    def sample_cpu(label):
        values = [snapshot()]
        for _ in range(a.samples-1):
            time.sleep(2)
            values.append(snapshot())
        first, last = values[0], values[-1]
        delta = last['cpu_ticks'] - first['cpu_ticks']
        report[label] = {'samples': values, 'seconds': last['uptime']-first['uptime'],
                         'cpu_percent_one_core': 100*(last['ticks']-first['ticks'])*last['cores']/delta,
                         'rss_kib_min': min(x['rss_kib'] for x in values),
                         'rss_kib_max': max(x['rss_kib'] for x in values)}
        print(label, json.dumps({k:v for k,v in report[label].items() if k != 'samples'}), flush=True)

    try:
        report['board'] = json.loads(run('ubus call system board'))
        report['packages'] = run("apk list --installed | grep -E 'zen|libubus|libubox'")
        report['status'] = rpc('getStatus')
        report['config'] = run('uci show zen-traffic')
        report['routes'] = run('ip route show')
        report['lan'] = json.loads(run('ubus call network.interface.lan status'))
        report['devices_before'] = rpc('getDevices')
        report['realtime_before'] = rpc('getRealtimeHistory')
        sample_cpu('baseline')
        report['rpc_roundtrip_ms'] = {}
        for method in ('getStatus', 'getDevices', 'getTotal', 'getHistory', 'getRealtimeHistory'):
            durations = []
            for _ in range(20):
                start = time.perf_counter()
                rpc(method)
                durations.append((time.perf_counter()-start)*1000)
            ordered = sorted(durations)
            report['rpc_roundtrip_ms'][method] = {'median': statistics.median(durations),
                'p95': ordered[math.ceil(len(ordered)*.95)-1], 'max': max(durations),
                'scope': 'SSH channel + ubus + JSON decode; not isolated daemon latency'}
        print('rpc', json.dumps(report['rpc_roundtrip_ms']), flush=True)
        devices = report['devices_before']['dev']
        if devices:
            mac = devices[0]['mac']
            report['mac_filter'] = {'mac': mac, 'match': rpc('getHistory', {'agg':'day', 'mac':mac}),
                                   'unknown': rpc('getHistory', {'agg':'day', 'mac':'02:00:00:00:00:ff'})}
        if a.transfer:
            size = 32*1024*1024
            token = __import__('secrets').token_hex(16)
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass
                def do_GET(self):
                    if self.path != '/' + token:
                        self.send_error(404); return
                    self.send_response(200); self.send_header('Content-Length', str(size)); self.end_headers()
                    chunk = b'\0'*65536
                    for _ in range(size//len(chunk)):
                        self.wfile.write(chunk)
                def do_POST(self):
                    if self.path != '/' + token:
                        self.send_error(404); return
                    remaining = int(self.headers.get('Content-Length', '0'))
                    if remaining != size:
                        self.send_error(400); return
                    while remaining:
                        data = self.rfile.read(min(remaining,65536))
                        if not data:
                            self.send_error(400); return
                        remaining -= len(data)
                    self.send_response(200); self.send_header('Content-Length','0'); self.end_headers()
            server = ThreadingHTTPServer((a.client_ip,0),Handler)
            server.daemon_threads = True
            threading.Thread(target=server.serve_forever,daemon=True).start()
            url = f'http://{a.client_ip}:{server.server_port}/{token}'
            temp = '/tmp/zen-baseline-' + token
            report['transfers'] = []
            try:
                run(f'dd if=/dev/zero of={temp} bs=1048576 count=32 2>/dev/null')
                for direction, flags in [('upload','-o /dev/null'), ('download',f'--data-binary @{temp} -o /dev/null')]:
                    before = rpc('getDevices'); resource_before = snapshot()
                    start = time.perf_counter()
                    output = run(f"curl --noproxy '*' --connect-timeout 5 --max-time 35 -fsS {flags} {shlex.quote(url)}")
                    seconds = time.perf_counter()-start
                    resource_after = snapshot()
                    time.sleep(2)
                    after = rpc('getDevices')
                    old = {x['mac']:x for x in before['dev']}
                    deltas = [{'mac':x['mac'], 'ip4':x.get('ip4'),
                               'rx_delta':x['rx_total']-old.get(x['mac'],{}).get('rx_total',0),
                               'tx_delta':x['tx_total']-old.get(x['mac'],{}).get('tx_total',0)} for x in after['dev']]
                    target = next((x for x in deltas if x['ip4']==a.client_ip), None)
                    key = 'tx_delta' if direction=='upload' else 'rx_delta'
                    delta_ticks = resource_after['cpu_ticks']-resource_before['cpu_ticks']
                    result = {'client_direction':direction, 'payload_bytes':size, 'seconds':seconds,
                              'mbps':size*8/seconds/1e6, 'target':target, 'device_deltas':deltas,
                              'relative_error': (target[key]-size)/size if target else None,
                              'daemon_cpu_percent_one_core':100*(resource_after['ticks']-resource_before['ticks'])*resource_after['cores']/delta_ticks,
                              'daemon_rss_kib':resource_after['rss_kib']}
                    report['transfers'].append(result)
                    print('transfer',json.dumps({k:v for k,v in result.items() if k != 'device_deltas'}),flush=True)
            finally:
                server.shutdown(); server.server_close()
                run(f'rm -f {temp}')
        if a.restart:
            before = rpc('getDevices')
            report['restart_before'] = before
            run('/etc/init.d/zen-traffic restart')
            for _ in range(20):
                time.sleep(1)
                try:
                    report['restart_status'] = rpc('getStatus')
                    break
                except (RuntimeError, json.JSONDecodeError):
                    continue
            else:
                raise RuntimeError('daemon did not recover within 20 seconds')
            after = rpc('getDevices'); report['restart_after'] = after
            old = {x['mac']:x for x in before['dev']}; new = {x['mac']:x for x in after['dev']}
            report['restart_preserved'] = all(mac in new and all(new[mac][key]>=x[key] for key in
                ('rx_total','tx_total','rx_today','tx_today','rx_month','tx_month')) for mac,x in old.items())
            print('restart_preserved', report['restart_preserved'],flush=True)
        report['logs'] = run('logread -e zen-traffic | tail -40')
    finally:
        Path(a.output).parent.mkdir(parents=True,exist_ok=True)
        Path(a.output).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        c.close()


if __name__ == '__main__':
    main()
