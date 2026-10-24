import * as fs from 'fs';
import * as uci from 'uci';
import * as ubus from 'ubus';
const model = loadfile('/usr/share/zen/device-binding-model.uc')();
const root = '/tmp/zen-device-binding';
function context() {
    fs.mkdir(root, 0700);
    const st = fs.lstat(root);
    if (!st || st.type != 'directory' || st.uid != 0) die('storage');
    fs.chmod(root, 0700); fs.mkdir(root + '/delta', 0700);
    const ctx = uci.cursor('/etc/config', root + '/delta', '');
    if (!ctx || !ctx.load('dhcp')) die('dhcp_unavailable');
    return ctx;
}
function hosts(ctx) {
    let result = [];
    ctx.foreach('dhcp', 'host', host => {
        let values = type(host.mac) == 'array' ? host.mac : split(host.mac || '', ' ');
        push(result, { section: host['.name'], ip: host.ip,
            macs: filter(map(values, model.mac), value => value != null) });
    });
    return result;
}
function binding(request) {
    const key = model.mac(request.mac);
    if (!key) return { ok: false, error: 'invalid_mac' };
    const ctx = context(), rows = filter(hosts(ctx), host => index(host.macs, key) >= 0);
    return { ok: true, ip: length(rows) == 1 ? rows[0].ip || '' : '', bound: length(rows) > 0,
        shared: length(rows) == 1 && length(rows[0].macs) > 1, ambiguous: length(rows) > 1 };
}
function change(request) {
    const ctx = context(), guard = fs.open(root + '/request.lock', 'a', 0600);
    if (!guard || !guard.lock('xn')) return { ok: false, error: 'busy' };
    let result;
    try {
        ctx.unload('dhcp'); if (!ctx.load('dhcp')) die('dhcp_unavailable');
        let lans = [], leases = { dhcp_leases: [] };
        if (request.enabled != false) {
            const bus = ubus.connect(); if (!bus) die('network_unavailable');
            const interfaces = bus.call('network.interface', 'dump', {});
            leases = bus.call('luci-rpc', 'getDHCPLeases', {});
            if (!interfaces || !leases) die('network_unavailable');
            let serving = [];
            ctx.foreach('dhcp', 'dhcp', section => {
                if (section.ignore != '1' && section.dhcpv4 != 'disabled') push(serving, section.interface);
            });
            for (let iface in interfaces.interface || [])
                if (index(serving, iface.interface) >= 0 && iface.up)
                    for (let address in iface['ipv4-address'] || []) push(lans, address);
        }
        const plan = model.plan(request, hosts(ctx), lans,
            map(leases.dhcp_leases || [], lease => ({ ip: lease.ipaddr, mac: lease.macaddr })));
        if (plan.error) result = { ok: false, error: plan.error };
        else if (plan.remove && !plan.section) result = { ok: true, bound: false, ip: '' };
        else {
            const before = fs.readfile('/etc/config/dhcp');
            if (before == null) die('storage');
            if (plan.remove && plan.section) {
                if (length(plan.remaining)) { if (!ctx.set('dhcp', plan.section, 'mac', plan.remaining)) die('storage'); }
                else if (!ctx.delete('dhcp', plan.section)) die('storage');
            }
            if (!plan.remove) {
                let section = plan.section || ctx.add('dhcp', 'host');
                if (!section || !ctx.set('dhcp', section, 'mac', [plan.mac]) || !ctx.set('dhcp', section, 'ip', plan.ip)) die('storage');
            }
            if (!ctx.commit('dhcp')) die('storage');
            const committed = fs.readfile('/etc/config/dhcp');
            if (system('/etc/init.d/dnsmasq reload', 10000) != 0) {
                if (fs.readfile('/etc/config/dhcp') != committed) die('rollback_conflict');
                const temp = '/etc/config/.zen-dhcp.restore';
                if (fs.writefile(temp, before) != length(before) || !fs.chmod(temp, 0600) || !fs.rename(temp, '/etc/config/dhcp')) die('rollback_failed');
                if (system('/etc/init.d/dnsmasq reload', 10000) != 0) die('rollback_failed');
                result = { ok: false, error: 'dhcp_reload_failed', rolled_back: true };
            } else result = { ok: true, bound: !plan.remove, ip: plan.remove ? '' : plan.ip };
        }
    } catch (error) { result = { ok: false, error: error.message }; }
    fs.unlink(root + '/delta/dhcp'); guard.close();
    return result;
}
let response;
try {
    const request = json(fs.readfile('/dev/stdin', 4096) || '{}');
    response = ARGV[0] == 'getBinding' ? binding(request) : ARGV[0] == 'setBinding' ? change(request) : { ok: false, error: 'invalid_method' };
} catch (error) { response = { ok: false, error: error.message }; }
print(sprintf('%J\n', response));
