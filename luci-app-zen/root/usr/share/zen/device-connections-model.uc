// Read-only telemetry normalization; FDB layout is Linux struct __fdb_entry.
function mac(value) {
    if (type(value) != 'string' || !match(value, /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/)) return null;
    const key = lc(value);
    return (int(substr(key, 0, 2), 16) & 1) || key == '00:00:00:00:00:00' ? null : key;
}
function positive(value) {
    return (type(value) == 'int' || type(value) == 'double') && value > 0 ? value : null;
}
function station(entry, frequency, device) {
    const key = mac(entry.mac); if (!key) return null;
    let signal = entry.signal;
    if (type(signal) == 'int' && signal >= 2147483648) signal -= 4294967296;
    const seconds = entry.connected_time;
    return { mac: key, kind: 'wifi', device,
        band: positive(frequency) ? frequency < 3000 ? '2.4GHz' : frequency < 5945 ? '5GHz' : '6GHz' : null,
        signal_dbm: type(signal) == 'int' && signal < 0 && signal >= -127 ? signal : null,
        connected_seconds: type(seconds) == 'int' && seconds >= 0 && seconds <= 315360000 ? seconds : null,
        upload_mbps: positive(entry.rx?.rate) ? entry.rx.rate / 1000.0 : null,
        download_mbps: positive(entry.tx?.rate) ? entry.tx.rate / 1000.0 : null };
}
function fdb(data) {
    let result = [];
    for (let offset = 0; offset + 16 <= length(data || ''); offset += 16) {
        if (ord(data, offset + 7)) continue; // router/local entry
        let bytes = [];
        for (let i = 0; i < 6; i++) push(bytes, sprintf('%02x', ord(data, offset + i)));
        const key = mac(join(':', bytes)), port = ord(data, offset + 6) | (ord(data, offset + 12) << 8);
        if (key && port) push(result, { mac: key, port });
    }
    return result;
}
return { mac, station, fdb };
