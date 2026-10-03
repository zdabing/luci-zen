"""Exercise the installed daemon against a disposable, capacity-limited tmpfs.

Requires Paramiko locally and root SSH, ip/netns, mount, curl and uhttpd.
Never fills production storage, changes the router clock, or stops production.
The temporary filesystem is 256 KiB; test packets stay in two namespaces.
"""
import argparse
import getpass
import hashlib
import importlib.util
import io
import json
import re
import secrets
import shlex
import sqlite3
import tarfile
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--host', required=True)
parser.add_argument('--port', type=int, default=22)
parser.add_argument('--user', default='root')
parser.add_argument('--host-key-sha256', required=True, help='Raw SSH key SHA256, 64 hex characters')
parser.add_argument('--helper', type=Path, required=True, help='Matching read-only tc-filter-dump executable')
parser.add_argument('--daemon-binary', type=Path, help='Optional verified target binary to stage; installed daemon remains untouched')
parser.add_argument('--clock-library', type=Path, help='Verified test-only AArch64 clock library, required for --rollover')
parser.add_argument('--rollover', action='store_true', help='Cross day/month in the isolated process while storage is full; router system clock stays unchanged')
parser.add_argument('--production-iface', default='br-lan')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
if args.rollover != bool(args.clock_library):
    parser.error('--rollover and --clock-library must be supplied together')
if args.output.exists() or list(args.output.parent.glob(args.output.stem+'-*')):
    parser.error('Use a fresh private output path; existing reports and snapshots are preserved')
assert re.fullmatch(r'[0-9a-fA-F]{64}', args.host_key_sha256)
assert re.fullmatch(r'[A-Za-z0-9_.-]{1,15}', args.production_iface)
helper_bytes = args.helper.read_bytes()
candidate_bytes = args.daemon_binary.read_bytes() if args.daemon_binary else None
clock_bytes = args.clock_library.read_bytes() if args.clock_library else None
spec = importlib.util.spec_from_file_location('attachment_decoder', ROOT / 'tools/tc-attachment-report.py')
decoder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decoder)

class PinnedKey(paramiko.MissingHostKeyPolicy):
    def missing_host_key(self, client, hostname, key):
        if hashlib.sha256(key.asbytes()).hexdigest() != args.host_key_sha256.lower():
            raise RuntimeError('SSH host key differs from the supplied fingerprint')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(PinnedKey())
ssh.connect(args.host, port=args.port, username=args.user,
            password=getpass.getpass('Router password: '), timeout=10)

def run(command, data=None, check=True):
    stdin, stdout, stderr = ssh.exec_command(command, timeout=25)
    if data is not None:
        stdin.channel.sendall(data)
        stdin.channel.shutdown_write()
    output, error = stdout.read(), stderr.read()
    status = stdout.channel.recv_exit_status()
    if check and status:
        raise RuntimeError({'command':command, 'exit':status,
                            'stdout':output.decode(errors='replace')[:500],
                            'stderr':error.decode(errors='replace')[:500]})
    return output if check else (status, output, error)

token = secrets.token_hex(4)
base = '/tmp/zen-storage-' + token
dbdir = base + '/db'
helper = base + '/query'
ns_router, ns_client = 'zsr'+token, 'zsc'+token
router_port, client_port = 'zsp'+token, 'zsl'+token
mac = '02:00:00:70:00:01'
created_namespaces = []
created_links = []
mounted = False
base_created = False
daemon_pid = server_pid = None
report = {'passed':False,'scope':('Staged target daemon' if candidate_bytes else 'Installed daemon')+'; full 256 KiB disposable tmpfs; isolated WAN-classified IPv4 packets; no system clock change',
          'token':token, 'phases':{}, 'samples':[]}

def progress(phase, **details):
    print(json.dumps({'phase':phase, **details}), flush=True)

def ns(name, command):
    return run('ip netns exec '+name+' '+command)

def hooks(namespace, iface, mode='tcx'):
    index = int(ns(namespace, 'ip -o link show dev '+iface).decode().split(':',1)[0])
    return decoder.decode(ns(namespace, helper+' '+str(index)+' '+mode), mode)

def production():
    return run('pidof zen-trafficd; sha256sum /usr/bin/zen-trafficd /etc/config/zen-traffic').decode()

def production_hooks():
    index = int(run('cat /sys/class/net/'+args.production_iface+'/ifindex'))
    return decoder.decode(run(helper+' '+str(index)+' tcx'), 'tcx')

def log():
    return run('cat '+base+'/daemon.log').decode(errors='replace')

def alive(pid, marker):
    return bool(run('test -r /proc/'+str(pid)+'/cmdline && grep -aq '+shlex.quote(marker)+
                    ' /proc/'+str(pid)+'/cmdline', check=False)[0] == 0)

def stop(pid, marker):
    if pid is None or not alive(pid, marker):
        return
    run('kill -TERM '+str(pid))
    for _ in range(30):
        if not alive(pid, marker):
            return
        time.sleep(.1)
    raise RuntimeError('Owned process did not stop: '+str(pid))

def wait_for(predicate, timeout, description):
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        if predicate():
            return
        if not alive(daemon_pid, dbdir+'/traffic.db'):
            raise RuntimeError('Isolated daemon exited while waiting for '+description)
        time.sleep(.25)
    raise RuntimeError('Timed out waiting for '+description)

def snapshot(label):
    # Validate a stable DB+WAL copy before opening it locally; never query production DB.
    files = run('for f in '+dbdir+'/traffic.db '+dbdir+'/traffic.db-wal; do [ ! -f "$f" ] || echo "$f"; done').decode().splitlines()
    for _ in range(8):
        before = run('sha256sum '+' '.join(files))
        status, archive, _ = run('tar -cf - -C '+dbdir+' '+
                                 ' '.join(Path(f).name for f in files), check=False)
        after = run('sha256sum '+' '.join(files))
        if status or before != after:
            continue
        hashes = {Path(line.split()[1]).name:line.split()[0] for line in before.decode().splitlines()}
        with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
            blobs = {m.name:stream.extractfile(m).read() for m in stream.getmembers() if m.isfile()}
        if set(blobs)==set(hashes) and all(hashlib.sha256(blobs[k]).hexdigest()==v for k,v in hashes.items()):
            break
    else:
        raise RuntimeError('No consistent fixture database snapshot')
    folder = args.output.parent / (args.output.stem+'-'+label)
    folder.mkdir(exist_ok=False)
    for name, data in blobs.items():
        (folder/name).write_bytes(data)
    conn = sqlite3.connect((folder/'traffic.db').resolve().as_uri()+'?mode=ro', uri=True)
    conn.execute('PRAGMA query_only=ON')
    def rows(sql):
        cur = conn.execute(sql)
        return [dict(zip([d[0] for d in cur.description], r)) for r in cur.fetchall()]
    result = {'integrity':conn.execute('PRAGMA integrity_check').fetchall(),
              'devices':rows('SELECT mac,rx_total,tx_total,last_seen FROM devices ORDER BY mac'),
              'daily':rows('SELECT * FROM daily_usage ORDER BY mac,date'),
              'monthly':rows('SELECT * FROM monthly_usage ORDER BY mac,month'),
              'wan_devices':rows('SELECT * FROM wan_devices ORDER BY mac'),
              'wan_window':rows('SELECT * FROM wan_window'), 'hashes':hashes}
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wan_daily'").fetchone():
        result['wan_daily']=rows('SELECT * FROM wan_daily ORDER BY date,mac')
    conn.close()
    assert result['integrity']==[('ok',)], result['integrity']
    report['phases'][label]=result
    return result

def accounting_tables(snapshot):
    tables=['devices','daily','monthly','wan_devices','wan_window']
    if 'wan_daily' in snapshot:tables.append('wan_daily')
    return tables

def transfer(size):
    # HTTP Content-Length and curl's received count verify the whole body reached the client.
    name='warmup' if size==65536 else 'payload'
    started=time.monotonic()
    raw=ns(ns_client,'curl --noproxy "*" --limit-rate 2M --connect-timeout 3 --max-time 15 '+
           '-fsS -o /dev/null -w "%{http_code} %{size_download}" http://192.0.2.254:17102/'+name)
    status,received=map(int,raw.decode().strip().split())
    assert status==200 and received==size, raw.decode()
    return {'received':received,'http_status':status,'seconds':time.monotonic()-started}

def set_fixture_epoch(epoch):
    # Replace an owned control file atomically outside the full test volume.
    run('cat > '+base+'/epoch.new', (str(epoch)+'\n').encode('ascii'))
    run('mv '+base+'/epoch.new '+base+'/epoch')

def interface_bytes():
    values=ns(ns_router, 'cat /sys/class/net/'+router_port+'/statistics/rx_bytes '+
              '/sys/class/net/'+router_port+'/statistics/tx_bytes').decode().split()
    return dict(zip(('rx_bytes','tx_bytes'),map(int,values)))

try:
    assert run('id -u').strip()==b'0', 'Router test requires root'
    report['production_before']=production()
    report['real_epoch_before']=int(run('date +%s'))
    real_mono_start=time.monotonic()
    for executable in ('ip','curl','mount','umount','uhttpd'):
        run('command -v '+executable)
    run('mkdir '+base)
    base_created=True
    run('mkdir '+dbdir)
    run('mkdir '+base+'/http')
    run('dd if=/dev/zero of='+base+'/http/warmup bs=65536 count=1 2>/dev/null')
    run('dd if=/dev/zero of='+base+'/http/payload bs=65536 count=128 2>/dev/null')
    run('cat > '+helper, helper_bytes)
    run('chmod 700 '+helper)
    daemon_command='/usr/bin/zen-trafficd'
    if candidate_bytes:
        daemon_command=base+'/daemon'
        run('cat > '+daemon_command,candidate_bytes)
        run('chmod 700 '+daemon_command)
        assert run('sha256sum '+daemon_command).decode().split()[0]==hashlib.sha256(candidate_bytes).hexdigest()
    report['tested_binary_sha256']=run('sha256sum '+daemon_command).decode().split()[0]
    daemon_environment=''
    if clock_bytes:
        run('cat > '+base+'/test-clock.so', clock_bytes)
        report['clock_library_sha256']=hashlib.sha256(clock_bytes).hexdigest()
        assert run('sha256sum '+base+'/test-clock.so').decode().split()[0]==report['clock_library_sha256']
        offset=run('date +%z').decode().strip()
        assert re.fullmatch(r'[+-]\d{4}', offset), offset
        minutes=(int(offset[1:3])*60+int(offset[3:]))*(1 if offset[0]=='+' else -1)
        fixture_zone=timezone(timedelta(minutes=minutes))
        fixture_dates=('2026-09-30','2026-10-01','2026-10-02')
        fixture_epochs=[int(datetime.fromisoformat(day+'T12:00:00').replace(tzinfo=fixture_zone).timestamp()) for day in fixture_dates]
        set_fixture_epoch(fixture_epochs[0])
        daemon_environment='env LD_PRELOAD='+base+'/test-clock.so ZEN_TEST_EPOCH_FILE='+base+'/epoch '
        report['scope']+='; controlled realtime only in isolated daemon; two rollovers and offline recovery'
    report['production_hooks_before']=production_hooks()
    run('mount -t tmpfs -o size=256k,mode=0700 tmpfs '+dbdir)
    mounted=True
    for name in (ns_router,ns_client):
        run('ip netns add '+name)
        created_namespaces.append(name)
        ns(name, 'ip link set lo up')
    run('ip link add '+client_port+' type veth peer name '+router_port)
    created_links.extend((client_port,router_port))
    run('ip link set '+client_port+' netns '+ns_client)
    run('ip link set '+router_port+' netns '+ns_router)
    ns(ns_client, 'ip link set '+client_port+' address '+mac)
    for name,iface,address in ((ns_router,router_port,'198.18.0.2/30'), (ns_client,client_port,'198.18.0.1/30')):
        ns(name,'ip addr add '+address+' dev '+iface)
        ns(name,'ip link set '+iface+' up')
    ns(ns_router,'ip addr add 192.0.2.254/32 dev lo')
    ns(ns_client,'ip route add 192.0.2.254/32 via 198.18.0.2')
    # Default route exists only in the isolated namespace, for interface ledger sampling.
    ns(ns_router,'ip route add default via 198.18.0.1 dev '+router_port)
    daemon_pid=int(run('ip netns exec '+ns_router+' '+daemon_environment+daemon_command+' -i '+router_port+
                      ' -P 198.18.0.0/30 -t 1000 -c 30 -d '+dbdir+'/traffic.db >'+base+
                      '/daemon.log 2>&1 </dev/null & echo $!'))
    wait_for(lambda:all(r['count']==1 for r in hooks(ns_router,router_port)), 5, 'TCX attachment')
    server_pid=int(run('ip netns exec '+ns_router+' uhttpd -f -p 192.0.2.254:17102 -h '+
                      base+'/http >'+base+'/http.log 2>&1 </dev/null & echo $!'))
    time.sleep(.3)
    transfer(65536)
    time.sleep(2.2)
    report['baseline_transfer']=transfer(8*1048576)
    wait_for(lambda:'checkpoint 完成' in log(), 35, 'first successful checkpoint')
    before=snapshot('before-fault')
    if args.rollover:
        assert {d['date'] for d in before['daily']}=={fixture_dates[0]},'Fixture clock did not control daemon date'
    baseline_device=next(d for d in before['devices'] if d['mac']==mac)
    baseline_wan=next(d for d in before['wan_devices'] if d['mac']==mac)
    assert abs(baseline_device['rx_total']/(8*1048576)-1)<=.1, baseline_device
    assert abs(baseline_wan['download_bytes']/(8*1048576)-1)<=.1, baseline_wan
    before_map=hooks(ns_router,router_port,'stats')
    progress('baseline-saved', checkpoint_errors=log().count('checkpoint 失败:'))
    status,_,err=run('dd if=/dev/zero of='+dbdir+'/owned-fill bs=4096 count=256', check=False)
    assert status != 0 and b'No space left' in err, (status,err.decode())
    report['full_filesystem']=run('df -k '+dbdir).decode()
    report['fault_transfer']=transfer(8*1048576)
    wait_for(lambda:'checkpoint 失败:' in log(),35,'actual SQLITE_FULL checkpoint failure')
    first_log=log()
    first_failures=first_log.count('checkpoint 失败:')
    started=time.monotonic()
    time.sleep(5)
    fault_log=log()
    report['retry_observation']={'seconds':time.monotonic()-started,
                               'additional_attempts':fault_log.count('checkpoint 失败:')-first_failures,
                               'configured_checkpoint_seconds':30, 'poll_interval_ms':1000}
    report['retry_bounded']=report['retry_observation']['additional_attempts']<=1
    failed=snapshot('during-fault')
    for table in accounting_tables(before):
        assert failed[table]==before[table], ('Partial commit while disk was full',table)
    during_map=hooks(ns_router,router_port,'stats')
    old=next(d for d in before_map if d['mac']==mac)
    new=next(d for d in during_map if d['mac']==mac)
    assert new['wan_rx_bytes']-old['wan_rx_bytes']>=8*1048576
    report['bpf_fault_delta']={k:new[k]-old[k] for k in ('wan_tx_bytes','wan_rx_bytes','lan_tx_bytes','lan_rx_bytes')}
    report['failure_atomic']=True
    progress('full-storage-observed', **report['retry_observation'])
    fault_payload=8*1048576
    if args.rollover:
        for date,epoch in zip(fixture_dates[1:],fixture_epochs[1:]):
            set_fixture_epoch(epoch)
            wait_for(lambda date=date:date in log(),5,'isolated calendar switch to '+date)
            unchanged=snapshot('failed-rollover-'+date)
            for table in accounting_tables(before):
                assert unchanged[table]==before[table],('Partial rollover commit while full',table)
            report['samples'].append({'date':date,'transfer':transfer(8*1048576)})
            fault_payload+=8*1048576
        time.sleep(2.2)
        offline_epoch=fixture_epochs[-1]+601
        set_fixture_epoch(offline_epoch)
        time.sleep(1.2)
    # A quiet HTTP client does not imply a quiet interface: ARP/IPv6 control
    # packets can still increase its WAN ledger. Stop only the owned fixture
    # link and allow the final sample before testing exact retry idempotence.
    ns(ns_router,'ip link set '+router_port+' down')
    time.sleep(2.2)
    report['interface_frozen']=interface_bytes()
    previous_successes=log().count('checkpoint 完成')
    run('rm -f '+dbdir+'/owned-fill')
    wait_for(lambda:log().count('checkpoint 完成')>previous_successes, 40,'checkpoint recovery')
    recovered=snapshot('recovered')
    device_before=next(d for d in before['devices'] if d['mac']==mac)
    device_after=next(d for d in recovered['devices'] if d['mac']==mac)
    wan_before=next(d for d in before['wan_devices'] if d['mac']==mac)
    wan_after=next(d for d in recovered['wan_devices'] if d['mac']==mac)
    for table,down,up in ((recovered['daily'],'download_bytes','upload_bytes'),(recovered['monthly'],'download_bytes','upload_bytes')):
        rows=[d for d in table if d['mac']==mac]
        assert (sum(row[down] for row in rows),sum(row[up] for row in rows))==(device_after['rx_total'],device_after['tx_total'])
    if args.rollover:
        assert device_after['last_seen']<offline_epoch-600,'Test device was not offline during recovery'
        report['offline_at_recovery']=True
        days={row['date']:row for row in recovered['daily'] if row['mac']==mac}
        assert set(days)==set(fixture_dates),days
        for date,payload in zip(fixture_dates,(16*1048576,8*1048576,8*1048576)):
            assert abs(days[date]['download_bytes']/payload-1)<=.1,(date,days[date])
        months={row['month']:row for row in recovered['monthly'] if row['mac']==mac}
        assert set(months)=={'2026-09','2026-10'},months
        for month in months:assert abs(months[month]['download_bytes']/(16*1048576)-1)<=.1,months[month]
        report['rollover_recovery_passed']=True
    assert recovered['wan_window'][0]['since']==before['wan_window'][0]['since']
    if 'wan_daily' in recovered:
        for device in recovered['wan_devices']:
            daily=[row for row in recovered['wan_daily'] if row['mac']==device['mac']]
            for direction in ('download_bytes','upload_bytes'):
                assert sum(row[direction] for row in daily)==device[direction],('Internet daily device mismatch',device['mac'],direction)
        network=[row for row in recovered['wan_daily'] if row['mac']=='']
        for direction in ('download_bytes','upload_bytes'):
            assert sum(row[direction] for row in network)==recovered['wan_window'][0][direction],('Internet daily network mismatch',direction)
        if args.rollover:
            assert {row['date'] for row in recovered['wan_daily'] if row['mac']==mac}==set(fixture_dates)
        report['internet_daily_recovery_passed']=True
    mixed_delta=device_after['rx_total']-device_before['rx_total']
    wan_delta=wan_after['download_bytes']-wan_before['download_bytes']
    report['recovery']={'mixed_download_delta':mixed_delta,'wan_download_delta':wan_delta,
                        'payload':fault_payload,'mixed_error_pct':(mixed_delta/fault_payload-1)*100,
                        'wan_error_pct':(wan_delta/fault_payload-1)*100}
    assert abs(report['recovery']['mixed_error_pct'])<=10
    assert abs(report['recovery']['wan_error_pct'])<=10
    report['recovery_passed']=True
    if args.rollover:report['offline_recovery_passed']=True
    progress('storage-recovered', **report['recovery'])
    # No traffic: a second successful batch must leave all byte counters unchanged.
    previous_successes=log().count('checkpoint 完成')
    wait_for(lambda:log().count('checkpoint 完成')>previous_successes,35,'idempotent next batch')
    repeat=snapshot('repeat-checkpoint')
    report['interface_at_repeat']=interface_bytes()
    assert report['interface_at_repeat']==report['interface_frozen'],'Fixture interface still carried traffic'
    for table in accounting_tables(recovered):
        assert repeat[table]==recovered[table], ('Counters duplicated on retry',table)
    report['repeat_idempotent']=True
    report['passed']=report['retry_bounded']
except Exception as error:
    report['error']=str(error)
    report['traceback']=traceback.format_exc()
    progress('test-error',error=str(error))
finally:
    cleanup_errors=[]
    def cleanup(fn):
        try:
            fn()
        except Exception as error:
            cleanup_errors.append(str(error))
    if mounted:
        cleanup(lambda:run('rm -f '+dbdir+'/owned-fill'))
    cleanup(lambda:stop(server_pid, 'uhttpd -f -p 192.0.2.254:17102 -h '+base+'/http'))
    cleanup(lambda:stop(daemon_pid, dbdir+'/traffic.db'))
    if ns_router in created_namespaces:
        cleanup(lambda:report.update(hooks_stopped=hooks(ns_router,router_port)))
    if mounted:
        cleanup(lambda:run('umount '+dbdir))
    for name in reversed(created_namespaces):
        cleanup(lambda name=name:run('ip netns delete '+name))
    for name in created_links:
        run('ip link delete '+name, check=False)
    cleanup(lambda:report.update(production_after=production()))
    cleanup(lambda:report.update(real_epoch_after=int(run('date +%s'))))
    if report.get('real_epoch_before') is not None and report.get('real_epoch_after') is not None:
        report['system_clock_unchanged']=abs((report['real_epoch_after']-report['real_epoch_before'])-(time.monotonic()-real_mono_start))<=5
        if not report['system_clock_unchanged']:cleanup_errors.append('Router realtime changed unexpectedly')
    if base_created:
        cleanup(lambda:report.update(production_hooks_after=production_hooks()))
        cleanup(lambda:report.update(daemon_log=log()))
    namespaces=run('ip netns list').decode()
    if any(name in namespaces for name in created_namespaces):
        cleanup_errors.append('Owned namespace remains')
    if report.get('hooks_stopped') and any(r['count'] for r in report['hooks_stopped']):
        cleanup_errors.append('Owned TCX attachment remains')
    if report.get('production_after') != report.get('production_before') or report.get('production_hooks_after') != report.get('production_hooks_before'):
        cleanup_errors.append('Production collector or attachments changed')
    # Remove only named, owned files; never recursively delete a computed router path.
    if base_created:
        for name in ('query','daemon','daemon.log','http.log','http/warmup','http/payload','test-clock.so','epoch','epoch.new'):
            cleanup(lambda name=name:run('rm -f '+base+'/'+name))
        cleanup(lambda:run('rmdir '+base+'/http '+dbdir+' '+base))
    report['cleanup_errors']=cleanup_errors
    report['cleanup_verified']=not cleanup_errors
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    ssh.close()
    progress('finished',passed=report.get('passed',False),cleanup_verified=not cleanup_errors)
if not report.get('passed') or not report['cleanup_verified']:
    raise SystemExit(1)
