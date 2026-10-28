import * as fs from 'fs';
import * as ubus from 'ubus';
const model = loadfile('/usr/share/zen/device-connections-model.uc')();
const bus = ubus.connect();
function call(object, method, args) {
    try { return bus?.call(object, method, args || {}); } catch (error) { return null; }
}
let devices = {}, ambiguous = {};
// No shell commands, writes, active scans or calls per client.
for (let bridge in fs.lsdir('/sys/class/net') || []) {
    if (!fs.stat('/sys/class/net/' + bridge + '/bridge')) continue;
    let ports = {};
    for (let port in fs.lsdir('/sys/class/net/' + bridge + '/brif') || []) {
        const number = int(trim(fs.readfile('/sys/class/net/' + bridge + '/brif/' + port + '/port_no') || ''), 16);
        const speed = int(trim(fs.readfile('/sys/class/net/' + port + '/speed') || ''));
        const carrier = trim(fs.readfile('/sys/class/net/' + port + '/carrier') || '');
        if (number > 0 && carrier == '1' && !fs.stat('/sys/class/net/' + port + '/phy80211'))
            ports[number] = { kind: 'wired', port, port_speed_mbps: speed > 0 && speed <= 1000000 ? speed : null };
    }
    const rows = model.fdb(fs.readfile('/sys/class/net/' + bridge + '/brforward', 65536));
    for (let row in rows) if (ports[row.port]) {
        if (devices[row.mac] && devices[row.mac].port != ports[row.port].port) ambiguous[row.mac] = true;
        devices[row.mac] = ports[row.port];
    }
}
for (let key in keys(ambiguous)) delete devices[key];
const wireless = call('iwinfo', 'devices');
for (let device in wireless?.devices || []) {
    const info = call('iwinfo', 'info', { device });
    const associated = call('iwinfo', 'assoclist', { device });
    for (let entry in associated?.results || []) {
        const station = model.station(entry, info?.frequency, device);
        if (station) devices[station.mac] = station;
    }
}
print(sprintf('%J\n', { ok: true, devices }));
