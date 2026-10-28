// Pure validation/planning. Shared by the rpcd adapter and isolated tests.
function mac(value) {
    if (type(value) != 'string' || !match(value, /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/)) return null;
    let key = lc(value);
    if (key == '00:00:00:00:00:00' || match(substr(key, 1, 1), /[13579bdf]/)) return null;
    return key;
}
function ipv4(value) {
    if (type(value) != 'string' || !match(value, /^\d{1,3}(\.\d{1,3}){3}$/)) return null;
    let parts = split(value, '.'), number = 0;
    for (let part in parts) {
        let octet = int(part);
        if (octet < 0 || octet > 255 || (length(part) > 1 && substr(part, 0, 1) == '0')) return null;
        number = number * 256 + octet;
    }
    return number;
}
function plan(request, hosts, lans, leases) {
    let key = mac(request.mac);
    if (!key || type(request.enabled) != 'bool') return { error: 'invalid_request' };
    let matching = filter(hosts, host => index(host.macs, key) >= 0);
    if (length(matching) > 1) return { error: 'ambiguous_binding' };
    let current = matching[0];
    if (!request.enabled) return { mac: key, remove: true, section: current?.section,
        remaining: current ? filter(current.macs, value => value != key) : [] };
    let ip = ipv4(request.ip);
    if (ip == null) return { error: 'invalid_ip' };
    let valid = false;
    for (let lan in lans) {
        let address = ipv4(lan.address), mask = lan.mask;
        if (address == null || type(mask) != 'int' || mask < 1 || mask > 30) continue;
        let size = 1;
        for (let bit = mask; bit < 32; bit++) size *= 2;
        let network = int(address / size) * size;
        if (ip == address) return { error: 'router_ip' };
        if (ip > network && ip < network + size - 1) valid = true;
    }
    if (!valid) return { error: 'outside_lan' };
    if (current && length(current.macs) > 1) return { error: 'shared_binding' };
    for (let host in hosts)
        if (host.section != current?.section && ipv4(host.ip) == ip) return { error: 'ip_conflict' };
    for (let lease in leases)
        if (ipv4(lease.ip) == ip && mac(lease.mac) != key) return { error: 'ip_conflict' };
    return { mac: key, ip: request.ip, section: current?.section, remove: false };
}
return { mac, ipv4, plan };
