import * as fs from 'fs';
const policy = loadfile('/usr/share/zen/update-model.uc')();
const root = '/tmp/zen-update', statePath = root + '/state.json';
const active = ['queued', 'checking', 'downloading', 'verifying', 'installing', 'restarting'];

function ensureRoot() {
    fs.mkdir(root, 0700);
    const st = fs.lstat(root);
    if (!st || st.type != 'directory' || st.uid != 0) die('storage');
    fs.chmod(root, 0700);
}
function readState() {
    try { return json(fs.readfile(statePath, 16384) || '{}'); } catch (e) { return {}; }
}
function save(job) {
    job.updated = time();
    const text = sprintf('%J', job);
    if (fs.writefile(statePath + '.new', text) != length(text)) die('storage');
    fs.chmod(statePath + '.new', 0600);
    if (!fs.rename(statePath + '.new', statePath)) die('storage');
}
function cleanup() {
    for (let name in ['package.apk', 'release.json', 'command.out']) fs.unlink(root + '/' + name);
    fs.rmdir(root + '/busy');
}
function publicState(job) {
    return { available: true, busy: index(active, job.stage) >= 0, job };
}
function quote(value) { return "'" + replace('' + value, /'/g, "'\\''") + "'"; }
function command(argv, timeout, maxOutput) {
    // All arguments are quoted; no command, path or option comes from RPC input.
    const output = root + '/command-' + fs.readlink('/proc/self') + '.out';
    const code = system(join(' ', map(argv, quote)) + ' >' + quote(output) + ' 2>&1', timeout);
    const text = fs.readfile(output, maxOutput || 4096) || '';
    fs.unlink(output);
    return { code, text };
}
function fetch(url, path, limit) {
    const result = command(['/usr/bin/curl', '--fail', '--silent', '--show-error', '--location',
        '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '90',
        '--max-filesize', '' + limit, '--output', path, url], 100000);
    if (result.code != 0) die('download');
    if (!fs.stat(path) || fs.stat(path).size > limit) die('download_size');
}
function status() {
    ensureRoot();
    const job = readState();
    if (index(active, job.stage) >= 0 && ((job.pid && !fs.stat('/proc/' + job.pid)) ||
        (!job.pid && time() - job.updated > 20))) {
        job.stage = 'failed'; job.error = 'interrupted'; save(job); cleanup();
    }
    return publicState(job);
}
function createJob(request) {
        const previous = status();
        if (previous.busy || (previous.job.pid && fs.stat('/proc/' + previous.job.pid)))
            return { ok: false, error: 'busy' };
        cleanup();
        if (!fs.mkdir(root + '/busy', 0700)) return { ok: false, error: 'busy' };
        if (!fs.stat('/usr/bin/apk')) { cleanup(); return { ok: false, error: 'apk_required' }; }
        const current = policy.installed(fs.readfile('/lib/apk/db/installed'))[request.package];
        if (!current) { cleanup(); return { ok: false, error: 'not_installed' }; }
        const job = { id: sprintf('%d-%s', time(), fs.readlink('/proc/self')), package: request.package,
            tag: request.tag, stage: 'queued', started: time() };
        save(job);
        const launched = command(['/etc/init.d/zen-update', 'start'], 10000);
        if (launched.code != 0) { job.stage = 'failed'; job.error = 'launch'; job.details = launched.text; save(job); cleanup(); }
        return { ok: launched.code == 0, ...publicState(job) };
}
function start(request) {
    if (!policy.validRequest(request)) return { ok: false, error: 'invalid_request' };
    ensureRoot();
    // Hold a request lock while checking the old job and creating the next one.
    const guard = fs.open(root + '/request.lock', 'a', 0600);
    if (!guard || !guard.lock('xn')) return { ok: false, error: 'busy' };
    let response;
    try { response = createJob(request); }
    catch (e) { guard.close(); die(e.message); }
    guard.close();
    return response;
}
function worker() {
    ensureRoot();
    const job = readState();
    if (job.stage != 'queued' || !policy.validRequest(job)) return;
    job.pid = fs.readlink('/proc/self');
    let packageLock;
    try {
        job.stage = 'checking'; save(job);
        const board = command(['/bin/ubus', 'call', 'system', 'board'], 10000, 65536);
        if (board.code != 0) die('board');
        fetch('https://api.github.com/repos/zdabing/luci-zen/releases/tags/' + job.tag, root + '/release.json', 1048576);
        const file = policy.candidate(json(fs.readfile(root + '/release.json')), job, json(board.text),
            policy.installed(fs.readfile('/lib/apk/db/installed'))[job.package]);
        job.version = file.version; save(job);
        let free = 0;
        if (fs.statvfs) {
            const space = fs.statvfs(root);
            if (space) free = space.bavail * space.frsize;
        } else {
            const df = command(['/bin/df', '-Pk', root], 5000);
            const rows = split(trim(df.text), '\n');
            const fields = split(trim(rows[length(rows) - 1] || ''), /\s+/);
            if (df.code == 0 && length(fields) >= 6) free = int(fields[length(fields) - 3]) * 1024;
        }
        if (free < file.size + 2097152) die('no_space');
        job.stage = 'downloading'; save(job);
        fetch('https://github.com/zdabing/luci-zen/releases/download/' + job.tag + '/' + file.filename,
            root + '/package.apk', file.size);
        job.stage = 'verifying'; save(job);
        const hash = command(['/usr/bin/sha256sum', root + '/package.apk'], 30000);
        if (fs.stat(root + '/package.apk')?.size != file.size || hash.code != 0 ||
            substr(hash.text, 0, 64) != file.sha256) die('checksum');
        // Re-check under the same package-manager lock used by LuCI.
        packageLock = fs.open('/tmp/ipkg.lock', 'a', 0600);
        if (!packageLock || !packageLock.lock('xn')) die('package_manager_busy');
        if (policy.compare(policy.installed(fs.readfile('/lib/apk/db/installed'))[job.package], file.version) !== -1)
            die('not_newer');
        job.stage = 'installing'; save(job);
        // Release APKs are pinned to HTTPS metadata + SHA256. Do not globally disable trust checks.
        const result = command(['/usr/bin/apk', 'add', '--upgrade', '--allow-untrusted', root + '/package.apk'], 600000);
        if (result.code != 0) { job.details = result.text; die('install'); }
        if (policy.installed(fs.readfile('/lib/apk/db/installed'))[job.package] != file.version) die('version');
        if (job.package == 'zen-traffic') {
            job.stage = 'restarting'; save(job);
            if (command(['/etc/init.d/zen-traffic', 'restart'], 60000).code != 0) die('restart');
            let running = false;
            for (let i = 0; i < 5; i++) {
                sleep(1000);
                const result = command(['/bin/ubus', 'call', 'zen.traffic', 'getStatus'], 5000);
                try { if (result.code == 0 && json(result.text).version == replace(file.version, /-r\d+$/, '')) running = true; } catch (e) {}
                if (running) break;
            }
            if (!running) die('restart');
        }
        job.stage = 'success';
    } catch (e) {
        job.stage = 'failed'; job.error = e.message || 'internal';
    }
    save(job); if (packageLock) packageLock.close(); cleanup();
}

try {
    if (ARGV[0] == 'worker') { worker(); exit(0); }
    if (ARGV[0] == 'status') print(sprintf('%J', status()));
    else if (ARGV[0] == 'start') {
        const input = fs.readfile('/dev/stdin', 4096);
        print(sprintf('%J', start(json(input || '{}'))));
    } else exit(2);
} catch (e) { print(sprintf('%J', { ok: false, available: true, error: 'internal' })); exit(1); }
