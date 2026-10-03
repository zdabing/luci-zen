#!/usr/bin/env bash
# Package-only cold build against the deployed 10Wrt OpenWrt/feed revisions.
# No firmware publication or deployment; generated kmods are not distributed.
set -euo pipefail
zen_root=$(pwd)
out="$zen_root/acceptance-out"
mkdir -p "$out"
printf 'phase\tattempt\tjobs\tstart_unix\tseconds\texit_code\n' > "$out/build-timings.tsv"
openwrt_rev=6ad13aa7290135ac6e1778be95d11b3034b9a416
packages_rev=42cd716d5df2a9694752098540af2a3def989f82
luci_rev=1fcad1ef1f5f28fe2b199dba8a060f9b5c58bb46
jobs=${BUILD_JOBS:-$(nproc)}
scope=${ZEN_PACKAGE_SCOPE:-all}
if [[ $scope == auto ]]; then
    # Existing backend/app artifacts remain valid for a theme-only source change.
    scope=all
    if git rev-parse HEAD^ >/dev/null 2>&1 &&
        git diff --name-only HEAD^ HEAD | grep -qE '^luci-theme-zen/' &&
        ! git diff --name-only HEAD^ HEAD | grep -qE '^(zen-traffic|luci-app-zen-traffic)/'; then
        scope=theme
    fi
fi
case "$scope" in all|theme) ;; *) echo "Invalid package scope: $scope" >&2; exit 2;; esac
printf '%s\n' "$scope" > "$out/package-scope.txt"

finish() {
    local status=$?
    if [[ -f "$zen_root/acceptance-openwrt/.config" ]]; then
        cp "$zen_root/acceptance-openwrt/.config" "$out/build.config"
    fi
    if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
        {
            printf '### R5C package-only acceptance build\n\n'
            printf 'Deployed OpenWrt: `%s`; Zen: `%s`.\n\n' "$openwrt_rev" "$(git -C "$zen_root" rev-parse HEAD)"
            printf '| Phase | Attempt | Jobs | Seconds | Exit |\n| --- | --- | --- | --- | --- |\n'
            awk -F '\t' 'NR>1 {printf "| %s | %s | %s | %s | %s |\n",$1,$2,$3,$5,$6}' "$out/build-timings.tsv"
        } >> "$GITHUB_STEP_SUMMARY"
    fi
    exit "$status"
}
trap finish EXIT
phase() {
    local target=$1 attempt=0 parallel start elapsed code
    for parallel in "$jobs" 1; do
        attempt=$((attempt+1)); start=$(date +%s)
        if make "$target" -j"$parallel" V=s 2>&1 | tee -a "$out/build.log"; then
            code=0
        else
            code=$?
        fi
        elapsed=$(( $(date +%s)-start ))
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$target" "$attempt" "$parallel" "$start" "$elapsed" "$code" >> "$out/build-timings.tsv"
        if (( code==0 )); then return 0; fi
    done
    return "$code"
}

git init acceptance-openwrt
cd acceptance-openwrt
git remote add origin https://github.com/openwrt/openwrt.git
git fetch --depth=1 origin "$openwrt_rev"
git checkout --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$openwrt_rev"
cat > feeds.conf <<EOF
src-git-full packages https://git.openwrt.org/feed/packages.git^${packages_rev}
src-git-full luci https://git.openwrt.org/project/luci.git^${luci_rev}
EOF
./scripts/feeds update -a
test "$(git -C feeds/packages rev-parse HEAD)" = "$packages_rev"
test "$(git -C feeds/luci rev-parse HEAD)" = "$luci_rev"
./scripts/feeds install luci-base
if [[ $scope == all ]]; then
    ./scripts/feeds install rust
    cp -r "$zen_root/zen-traffic" "$zen_root/luci-app-zen-traffic" package/
fi
cp -r "$zen_root/luci-theme-zen" package/
# Match the deployed toolchain, host BPF compiler, O2 and LTO selections.
sed -i 's/-Os/-O2/g' include/target.mk
cat > .config <<'EOF'
CONFIG_TARGET_rockchip=y
CONFIG_TARGET_rockchip_armv8=y
CONFIG_TARGET_rockchip_armv8_DEVICE_friendlyarm_nanopi-r5c=y
CONFIG_DEVEL=y
CONFIG_TOOLCHAINOPTS=y
CONFIG_BPF_TOOLCHAIN_HOST=y
CONFIG_BPF_TOOLCHAIN_HOST_PATH="/usr"
CONFIG_USE_GC_SECTIONS=y
CONFIG_USE_LTO=y
CONFIG_USE_APK=y
CONFIG_LUCI_LANG_zh_Hans=y
CONFIG_PACKAGE_luci-theme-zen=m
EOF
if [[ $scope == all ]]; then
    printf 'CONFIG_PACKAGE_zen-traffic=m\nCONFIG_PACKAGE_luci-app-zen-traffic=m\n' >> .config
fi
make defconfig
for setting in CONFIG_USE_MUSL=y CONFIG_USE_LTO=y CONFIG_USE_APK=y \
    CONFIG_PACKAGE_luci-theme-zen=m; do
    grep -qxF "$setting" .config
done
if [[ $scope == all ]]; then
for setting in CONFIG_PACKAGE_zen-traffic=m CONFIG_PACKAGE_luci-app-zen-traffic=m; do
    grep -qxF "$setting" .config
done
rust_makefile=feeds/packages/lang/rust/Makefile
grep -qxF 'PKG_VERSION:=1.96.0' "$rust_makefile"
ci_llvm=https://ci-artifacts.rust-lang.org/rustc-builds/ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96/rust-dev-1.96.0-x86_64-unknown-linux-gnu.tar.xz
curl -fsSIL --retry 2 "$ci_llvm" >/dev/null
sed -i 's/--set=llvm.download-ci-llvm=false/--set=llvm.download-ci-llvm=true/' "$rust_makefile"
fi
printf 'OpenWrt\t%s\npackages\t%s\nluci\t%s\nZen\t%s\n' \
    "$openwrt_rev" "$packages_rev" "$luci_rev" "$(git -C "$zen_root" rev-parse HEAD)" > "$out/sources.tsv"
phase tools/compile
names=(luci-theme-zen)
if [[ $scope == all ]]; then
phase toolchain/compile
# bpf-headers reads the target kernel config. Build it without image packaging.
phase target/linux/compile
phase package/zen-traffic/compile
phase package/luci-app-zen-traffic/compile
names+=(zen-traffic luci-app-zen-traffic)
fi
phase package/luci-theme-zen/compile
for name in "${names[@]}"; do
    mapfile -t files < <(find bin/packages -type f -name "${name}-*.apk")
    test "${#files[@]}" -eq 1
    cp "${files[0]}" "$out/"
done
(cd "$out" && sha256sum ./*.apk > SHA256SUMS && sha256sum -c SHA256SUMS)
