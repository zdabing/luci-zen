"""Execute read-only connection telemetry with real ucode and a temporary sysfs tree."""
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]

@unittest.skipUnless(os.environ.get('UCODE_BIN'), 'Set UCODE_BIN to a real ucode interpreter')
class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.net = self.root/'net'; self.net.mkdir()
        source = (REPO/'luci-theme-zen/root/usr/share/zen/device-connections.uc').read_text()
        source = source.replace("import * as ubus from 'ubus';", "const ubus = { connect: () => ({ call: (object, method, args) => { const data = json(fs.readfile('"+str(self.root/'rpc.json')+"')); return method == 'devices' ? data.devices : data[args.device]?.[method]; } }) };")
        source = source.replace('/sys/class/net',str(self.net)).replace('/usr/share/zen/device-connections-model.uc',str(REPO/'luci-theme-zen/root/usr/share/zen/device-connections-model.uc'))
        self.worker = self.root/'worker.uc'; self.worker.write_text(source)
        self.rpc = {'devices':{'devices':['phy0-ap0']},'phy0-ap0':{'info':{'frequency':5180},'assoclist':{'results':[
            {'mac':'02:00:00:00:00:02','signal':4294967238,'connected_time':12000,'rx':{'rate':433300},'tx':{'rate':866700}},
            {'mac':'02:00:00:00:00:03','signal':0}, {'mac':'ff:ff:ff:ff:ff:ff','signal':-50}]}}}
        bridge = self.net/'br-lan'; (bridge/'bridge').mkdir(parents=True)
        self.port('lan1',1,1000); self.port('lan2',257,2500)
        self.entries = [(0,1,False),(1,257,False),(7,1,True)]
    def port(self,name,number,speed,carrier=1):
        port = self.net/name; port.mkdir(exist_ok=True)
        (port/'speed').write_text(str(speed)); (port/'carrier').write_text(str(carrier))
        member=self.net/'br-lan/brif'/name;member.mkdir(parents=True,exist_ok=True)
        (member/'port_no').write_text(hex(number))
    def run_worker(self):
        (self.root/'rpc.json').write_text(json.dumps(self.rpc))
        payload=b''.join(struct.pack('<6sBBIBBH',bytes([2,0,0,0,0,tail]),port&255,local,0,port>>8,0,0) for tail,port,local in self.entries)
        (self.net/'br-lan/brforward').write_bytes(payload+b'partial')
        command=[os.environ['UCODE_BIN']]
        if os.environ.get('UCODE_LIB_PATH'):command+=['-L',os.environ['UCODE_LIB_PATH']]
        result=subprocess.run([*command,str(self.worker)],text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        return json.loads(result.stdout)['devices']
    def test_real_telemetry_units_signed_signal_and_fdb_ports(self):
        rows=self.run_worker()
        self.assertEqual(rows['02:00:00:00:00:00']['port_speed_mbps'],1000)
        self.assertEqual(rows['02:00:00:00:00:01']['port'],'lan2')
        wifi=rows['02:00:00:00:00:02']
        self.assertEqual(wifi['band'],'5GHz');self.assertEqual(wifi['signal_dbm'],-58)
        self.assertEqual(wifi['connected_seconds'],12000)
        self.assertAlmostEqual(wifi['upload_mbps'],433.3);self.assertAlmostEqual(wifi['download_mbps'],866.7)
        self.assertIsNone(rows['02:00:00:00:00:03']['signal_dbm'])
        self.assertNotIn('ff:ff:ff:ff:ff:ff',rows);self.assertNotIn('02:00:00:00:00:07',rows)
    def test_missing_wireless_and_disconnected_ports_do_not_invent_values(self):
        self.rpc={};(self.net/'lan1/carrier').write_text('0');(self.net/'lan2/speed').write_text('-1')
        rows=self.run_worker();self.assertNotIn('02:00:00:00:00:00',rows)
        self.assertIsNone(rows['02:00:00:00:00:01']['port_speed_mbps'])
        self.assertNotIn('02:00:00:00:00:02',rows)
    def test_ambiguous_fdb_mapping_is_omitted(self):
        self.entries.append((0,257,False))
        self.assertNotIn('02:00:00:00:00:00',self.run_worker())

if __name__=='__main__':unittest.main()
