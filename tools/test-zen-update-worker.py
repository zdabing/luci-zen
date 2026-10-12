"""Run the real ucode worker in an isolated filesystem with fake external commands.

No network, router, APK database or service is modified. Requires UCODE_BIN.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
UCODE = os.environ.get('UCODE_BIN')
PAYLOAD = b'fixture apk bytes'

def mock_command(kind, args):
    root = Path(os.environ['ZEN_UPDATE_FIXTURE'])
    calls = root/'calls.jsonl'
    with calls.open('a') as stream: stream.write(json.dumps([kind,*args])+'\n')
    mode = (root/'mode').read_text()
    if kind == 'curl':
        output = Path(args[args.index('--output')+1])
        if mode == 'download-error': return 7
        output.write_bytes((root/'release.json').read_bytes() if '/api.github.com/' in args[-1] else PAYLOAD)
    elif kind == 'apk':
        if mode == 'install-error': print('fixture dependency conflict'); return 1
        (root/'installed').write_text('P:zen-traffic\nV:0.2.3-r1\n\nP:luci-theme-zen\nV:0.2.3-r1\n')
    elif kind == 'ubus':
        print(json.dumps({'release':{'target':'rockchip/armv8','version':'25.12-SNAPSHOT'}} if args[1]=='system' else {'version':'0.2.3'}))
    return 0

@unittest.skipUnless(UCODE, 'Set UCODE_BIN to run the production ucode worker')
class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**os.environ,'ZEN_UPDATE_FIXTURE':str(self.root)}
        self.set_mode('good')
        self.package = {'name':'zen-traffic','version':'0.2.3-r1','filename':'zen-traffic-0.2.3-r1-rockchip-armv8.apk',
            'size':len(PAYLOAD),'sha256':hashlib.sha256(PAYLOAD).hexdigest()}
        self.write_release()
        (self.root/'installed').write_text('P:zen-traffic\nV:0.2.2-r1\n\nP:luci-theme-zen\nV:0.2.2-r1\n')
        source = (REPO/'luci-theme-zen/root/usr/share/zen/update.uc').read_text()
        source = source.replace('/tmp/zen-update',str(self.root/'job')).replace('/tmp/ipkg.lock',str(self.root/'ipkg.lock'))
        source = source.replace("st.uid != 0", "st.uid != "+str(os.getuid()))
        source = source.replace('/usr/share/zen/update-model.uc',str(REPO/'luci-theme-zen/root/usr/share/zen/update-model.uc'))
        source = source.replace('/lib/apk/db/installed',str(self.root/'installed'))
        for path,kind in [('/usr/bin/curl','curl'),('/usr/bin/apk','apk'),('/bin/ubus','ubus'),
                ('/etc/init.d/zen-update','launch'),('/etc/init.d/zen-traffic','service')]:
            wrapper = self.root/kind
            wrapper.write_text('#!/bin/sh\nexec '+str(Path(sys.executable))+' '+str(Path(__file__).resolve())+' --mock '+kind+' "$@"\n')
            wrapper.chmod(0o700); source = source.replace(path,str(wrapper))
        self.script = self.root/'update.uc';self.script.write_text(source)

    def set_mode(self, value): (self.root/'mode').write_text(value)
    def write_release(self):
        metadata = {'schema':1,'repo':'zdabing/luci-zen','tag':'v0.2.3','target':'rockchip/armv8','sdk_version':'25.12.5','packages':[self.package]}
        (self.root/'release.json').write_text(json.dumps({'tag_name':'v0.2.3','body':'<!-- zen-update-metadata '+json.dumps(metadata)+' -->',
            'assets':[{'name':self.package['filename'],'size':self.package['size'],'state':'uploaded','digest':'sha256:'+self.package['sha256']}]}))
    def run_ucode(self, mode, request=None):
        module_path = ['-L',os.environ['UCODE_LIB_PATH']] if os.environ.get('UCODE_LIB_PATH') else []
        result = subprocess.run([UCODE,*module_path,str(self.script),mode],input=json.dumps(request or {}),text=True,capture_output=True,env=self.env)
        self.assertEqual(result.returncode,0,result.stderr+'\n'+result.stdout)
        return json.loads(result.stdout) if result.stdout else None
    def start(self): return self.run_ucode('start',{'package':self.package['name'],'tag':'v0.2.3'})
    def calls(self):
        return [json.loads(line) for line in (self.root/'calls.jsonl').read_text().splitlines()]

    def test_success_serialization_resume_and_cleanup(self):
        self.assertTrue(self.start()['ok'])
        self.assertEqual(self.start()['error'],'busy')
        self.assertTrue(self.run_ucode('status')['busy'])
        self.run_ucode('worker')
        status = self.run_ucode('status')
        self.assertEqual(status['job']['stage'],'success');self.assertFalse(status['busy'])
        apk = [call for call in self.calls() if call[0]=='apk']
        self.assertEqual(len(apk),1);self.assertEqual(apk[0][1:4],['add','--upgrade','--allow-untrusted'])
        self.assertTrue(any(call[0]=='service' for call in self.calls()))
        self.assertFalse((self.root/'job/package.apk').exists());self.assertFalse((self.root/'job/busy').exists())
        self.assertEqual(self.run_ucode('status')['job']['id'],status['job']['id'],'Result survives a new RPC process')

    def test_checksum_failure_never_installs(self):
        self.package['sha256']='a'*64;self.write_release();self.start();self.run_ucode('worker')
        self.assertEqual(self.run_ucode('status')['job']['error'],'checksum')
        self.assertFalse(any(call[0]=='apk' for call in self.calls()))

    def test_download_failure_never_installs(self):
        self.set_mode('download-error');self.start();self.run_ucode('worker')
        self.assertEqual(self.run_ucode('status')['job']['error'],'download')
        self.assertFalse(any(call[0]=='apk' for call in self.calls()))

    def test_failed_install_preserves_versions_and_error(self):
        self.set_mode('install-error');self.start();self.run_ucode('worker')
        state=self.run_ucode('status')['job']
        self.assertEqual(state['error'],'install');self.assertIn('dependency conflict',state['details'])
        self.assertIn('0.2.2-r1',(self.root/'installed').read_text());self.assertTrue(self.start()['ok'])

    def test_wrong_target_never_downloads_apk(self):
        release=json.loads((self.root/'release.json').read_text())
        release['body']=release['body'].replace('rockchip/armv8','x86/64')
        (self.root/'release.json').write_text(json.dumps(release));self.start();self.run_ucode('worker')
        self.assertEqual(self.run_ucode('status')['job']['error'],'incompatible')
        self.assertEqual(len([call for call in self.calls() if call[0]=='curl']),1)

    def test_dead_worker_recovers_lock_without_installing(self):
        self.start();path=self.root/'job/state.json';job=json.loads(path.read_text())
        job.update(stage='installing',pid='99999999');path.write_text(json.dumps(job))
        self.assertEqual(self.run_ucode('status')['job']['error'],'interrupted');self.assertTrue(self.start()['ok'])

    def test_package_manager_lock_prevents_install(self):
        import fcntl
        with (self.root/'ipkg.lock').open('w') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);self.start();self.run_ucode('worker')
        self.assertEqual(self.run_ucode('status')['job']['error'],'package_manager_busy')
        self.assertFalse(any(call[0]=='apk' for call in self.calls()))

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--mock':sys.exit(mock_command(sys.argv[2],sys.argv[3:]))
    unittest.main()
