// Shared policy for the privileged updater. No browser-supplied URL or hash.
const packages = ['luci-theme-zen', 'luci-app-zen-traffic', 'zen-traffic'];
function validRequest(request) {
    return type(request) == 'object' && index(packages, request.package) >= 0 &&
        type(request.tag) == 'string' && match(request.tag, /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/) != null;
}
function compare(a, b) {
    const re = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-(?:r)?(\d{1,9}))?$/;
    const x = match(a || '', re), y = match(b || '', re);
    if (!x || !y) return null;
    for (let i = 1; i <= 4; i++) {
        const d = int(x[i] || 0) - int(y[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    return 0;
}
function installed(text) {
    const versions = {};
    for (let block in split(replace(text || '', /\r/g, ''), /\n\s*\n/)) {
        let name, version;
        for (let line in split(block, '\n')) {
            if (substr(line, 0, 2) == 'P:') name = substr(line, 2);
            if (substr(line, 0, 2) == 'V:') version = substr(line, 2);
        }
        if (name && version && index(packages, name) >= 0) versions[name] = version;
    }
    return versions;
}
function major(version) {
    const m = match(version || '', /^(\d{2})(?:\.\d+)*(?:[-+][A-Za-z0-9._+-]+)?$/);
    return m ? m[1] : null;
}
function candidate(release, request, board, current) {
    if (!validRequest(request) || !current || release.draft || release.prerelease || release.tag_name != request.tag)
        die('invalid_release');
    const marker = match(release.body || '', /<!-- zen-update-metadata\s+([\s\S]*?)\s*-->/);
    if (!marker || length(marker[1]) > 65536) die('invalid_metadata');
    const root = json(marker[1]);
    const builds = [root];
    if (root.builds != null) {
        if (type(root.builds) != 'array' || length(root.builds) > 31) die('invalid_metadata');
        for (let build in root.builds) push(builds, build);
    }
    for (let build in builds) {
        if (build.schema != 1 || build.repo != 'zdabing/luci-zen' || build.tag != request.tag ||
            type(build.target) != 'string' || type(build.packages) != 'array') die('invalid_metadata');
        if (request.package == 'zen-traffic' && (build.target != board.release?.target ||
            !major(board.release?.version) || major(build.sdk_version) != major(board.release?.version))) continue;
        for (let file in build.packages) {
            if (file.name != request.package) continue;
            const suffix = replace(build.target, '/', '-');
            if (type(file.version) != 'string' || compare(current, file.version) !== -1) die('not_newer');
            if (file.filename != file.name + '-' + file.version + '.apk' &&
                file.filename != file.name + '-' + file.version + '-' + suffix + '.apk') die('invalid_filename');
            if (type(file.size) != 'int' || file.size <= 0 || file.size > 33554432 ||
                type(file.sha256) != 'string' || !match(file.sha256, /^[a-f0-9]{64}$/)) die('invalid_metadata');
            let uploaded = false;
            for (let asset in release.assets || []) {
                if (asset.name == file.filename && asset.state == 'uploaded' && asset.size == file.size &&
                    (!asset.digest || asset.digest == 'sha256:' + file.sha256)) uploaded = true;
            }
            if (!uploaded) die('invalid_asset');
            return file;
        }
    }
    die('incompatible');
}
return { packages, validRequest, compare, installed, candidate };
