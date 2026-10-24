"""Execute the actual rpcd worker and libuci against an isolated DHCP config.

Requires UCODE_BIN and the real fs/uci modules. Only network discovery and the
dnsmasq service command are substituted; production validation/commit/rollback run.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
UCODE = os.environ.get('UCODE_BIN')

@unittest.skipUnless(UCODE, 'Set UCODE_BIN to an interpreter with libuci support')
class BindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); (self.root/'config').mkdir()
        self.config = self.root/'config/dhcp'
        self.config.write_text("config dhcp 'lan'\n option interface 'lan'\n option limit '100'\n\nconfig host 'printer'\n option mac '02:00:00:00:00:02'\n option ip '192.168.1.120'\n option name 'printer'\n option leasetime '12h'\n")
        self.network = {'dump':{'interface':[{'interface':'lan','up':True,'ipv4-address':[{'address':'192.168.1.1','mask':24}]}]},
            'getDHCPLeases':{'dhcp_leases':[{'macaddr':'02:00:00:00:00:03','ipaddr':'192.168.1.121'}]}}
        (self.root/'network.json').write_text(json.dumps(self.network))
        reload = self.root/'reload.sh'
        reload.write_text('#!/bin/sh\necho reload >> "'+str(self.root/'calls')+'"\nif [ -f "'+str(self.root/'fail-once')+'" ]; then rm "'+str(self.root/'fail-once')+'"; exit 1; fi\nexit 0\n')
        reload.chmod(0o700)
        source = (REPO/'luci-theme-zen/root/usr/share/zen/device-binding.uc').read_text()
        source = source.replace("import * as ubus from 'ubus';", "const ubus = { connect: () => ({ call: (object, method, args) => json(fs.readfile('"+str(self.root/'network.json')+"'))[method] }) };")
        source = source.replace('/usr/share/zen/device-binding-model.uc',str(REPO/'luci-theme-zen/root/usr/share/zen/device-binding-model.uc'))
        source = source.replace('/tmp/zen-device-binding',str(self.root/'work')).replace('/etc/config',str(self.root/'config'))
        source = source.replace("st.uid != 0", 'st.uid != '+str(os.getuid()))
        source = source.replace("'/etc/init.d/dnsmasq reload'", "'"+str(reload)+"'")
        self.script=self.root/'binding.uc';self.script.write_text(source)
        self.mac='02:00:00:00:00:01'
    def run_worker(self,method,**request):
        module_path=['-L',os.environ['UCODE_LIB_PATH']] if os.environ.get('UCODE_LIB_PATH') else []
        result=subprocess.run([UCODE,*module_path,str(self.script),method],input=json.dumps({'mac':self.mac,**request}),text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr+'\n'+result.stdout)
        return json.loads(result.stdout)
    def test_bind_replace_reopen_and_unbind_preserve_unrelated_options(self):
        original=self.config.read_text()
        self.assertFalse(self.run_worker('getBinding')['bound'])
        self.assertTrue(self.run_worker('setBinding',enabled=True,ip='192.168.1.108')['ok'])
        self.assertEqual(self.run_worker('getBinding')['ip'],'192.168.1.108')
        self.assertTrue(self.run_worker('setBinding',enabled=True,ip='192.168.1.109')['ok'])
        self.assertEqual(self.run_worker('getBinding')['ip'],'192.168.1.109')
        self.assertTrue(self.run_worker('setBinding',enabled=False,ip='')['ok'])
        self.assertFalse(self.run_worker('getBinding')['bound'])
        self.assertIn("option leasetime '12h'",self.config.read_text())
        self.assertIn("option name 'printer'",self.config.read_text())
        self.assertIn("option ip '192.168.1.120'",self.config.read_text())
        self.assertEqual((self.root/'calls').read_text().count('reload'),3)
    def test_rejected_changes_never_commit_or_reload(self):
        original=self.config.read_bytes()
        for ip,error in [('192.168.1.120','ip_conflict'),('192.168.1.121','ip_conflict'),('192.168.1.1','router_ip'),('192.168.2.8','outside_lan'),('192.168.1.999','invalid_ip')]:
            self.assertEqual(self.run_worker('setBinding',enabled=True,ip=ip)['error'],error)
            self.assertEqual(self.config.read_bytes(),original)
        self.assertFalse((self.root/'calls').exists())
    def test_reload_failure_restores_exact_config(self):
        original=self.config.read_bytes();(self.root/'fail-once').touch()
        result=self.run_worker('setBinding',enabled=True,ip='192.168.1.108')
        self.assertFalse(result['ok']);self.assertTrue(result['rolled_back']);self.assertEqual(result['error'],'dhcp_reload_failed')
        self.assertEqual(self.config.read_bytes(),original)
        self.assertFalse(self.run_worker('getBinding')['bound'])
        self.assertEqual((self.root/'calls').read_text().count('reload'),2)
    def test_shared_binding_removal_keeps_other_device(self):
        with self.config.open('a') as stream:stream.write("\nconfig host 'shared'\n list mac '02:00:00:00:00:01'\n list mac '02:00:00:00:00:04'\n option ip '192.168.1.130'\n option name 'shared-host'\n")
        self.assertTrue(self.run_worker('getBinding')['shared'])
        self.assertEqual(self.run_worker('setBinding',enabled=True,ip='192.168.1.108')['error'],'shared_binding')
        self.assertTrue(self.run_worker('setBinding',enabled=False,ip='')['ok'])
        self.assertIn('02:00:00:00:00:04',self.config.read_text())
        self.assertNotIn(self.mac,self.config.read_text())
    def test_unbinding_does_not_require_network_discovery(self):
        self.assertTrue(self.run_worker('setBinding',enabled=True,ip='192.168.1.108')['ok'])
        (self.root/'network.json').write_text('{}')
        self.assertTrue(self.run_worker('setBinding',enabled=False,ip='')['ok'])
        self.assertFalse(self.run_worker('getBinding')['bound'])

if __name__=='__main__':unittest.main()
