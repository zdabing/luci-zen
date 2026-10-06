#!/usr/bin/env bash
# Build a flat, signed APK v3 repository using the SDK's own host apk.
set -euo pipefail
apk=${1:?SDK host apk required}
key=${2:?Private EC signing key required}
directory=${3:?Package directory required}
test -x "$apk"
test -s "$key"
[[ "${APK_PACKAGE_BASE:-}" =~ ^https://github.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/[A-Za-z0-9_.-]+$ ]]
apk=$(realpath "$apk")
key=$(realpath "$key")
cd "$directory"
shopt -s nullglob
packages=(*.apk)
test "${#packages[@]}" -eq 4
for name in luci-theme-zen luci-app-zen-traffic zen-traffic zen-full; do
  matches=("$name"-[0-9]*.apk)
  test "${#matches[@]}" -eq 1
done
openssl pkey -in "$key" -pubout -out zen-repository.pem
openssl pkey -pubin -in zen-repository.pem -text -noout | grep -q 'ASN1 OID: prime256v1'
# Replace ephemeral build-host signatures with the persistent repository key.
"$apk" adbsign --reset-signatures --sign "$key" "${packages[@]}"
"$apk" mkndx --allow-untrusted --sign "$key" --output packages.adb \
  --pkgname-spec "${APK_PACKAGE_BASE:?Immutable HTTPS package URL required}/"'${name}-${version}.apk' "${packages[@]}"
"$apk" --keys-dir . verify packages.adb "${packages[@]}"
sha256sum "${packages[@]}" packages.adb zen-repository.pem > SHA256SUMS
