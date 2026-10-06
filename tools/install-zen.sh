#!/bin/sh
# Configure a verified SDK-specific feed, then let APK resolve dependencies.
set -eu
key=${1:?Usage: install-zen.sh <downloaded-public-key.pem> <expected-sha256> [theme|full]}
fingerprint=${2:?Expected public key SHA256 required}
scope=${3:-full}
case "$scope" in
  theme) package=luci-theme-zen ;;
  full) package=zen-full ;;
  *) echo 'Expected theme or full' >&2; exit 1 ;;
esac
command -v apk >/dev/null
. /etc/openwrt_release
[ "$DISTRIB_ID" = OpenWrt ] || {
  echo 'This feed supports official OpenWrt releases. Custom/ImmortalWrt builds need their own validated feed.' >&2
  exit 1
}
printf '%s\n' "$DISTRIB_RELEASE" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'
printf '%s\n' "$DISTRIB_TARGET" | grep -Eq '^[a-z0-9_-]+/[a-z0-9_-]+$'
printf '%s\n' "$fingerprint" | grep -Eq '^[a-f0-9]{64}$'
[ "$(sha256sum "$key" | cut -d ' ' -f 1)" = "$fingerprint" ] || {
  echo 'Public key fingerprint mismatch' >&2; exit 1;
}
grep -q '^-----BEGIN PUBLIC KEY-----' "$key"
destination=/etc/apk/keys/zen-repository.pem
if [ -f "$destination" ] && ! cmp -s "$key" "$destination"; then
  echo 'Repository key changed; explicit key rotation required' >&2
  exit 1
fi
tag="feed-openwrt-${DISTRIB_RELEASE}-$(printf '%s' "$DISTRIB_TARGET" | tr / -)"
url="https://github.com/zdabing/luci-zen/releases/download/$tag/packages.adb"
mkdir -p /etc/apk/keys
cp "$key" "$destination"
chmod 644 "$destination"
# Use a dedicated file; keep the firmware's existing repositories intact.
mkdir -p /etc/apk/repositories.d
printf '%s\n' "$url" > /etc/apk/repositories.d/zen.list
apk update
# If matching kernel modules cannot be resolved, stop before installation.
apk add --simulate "$package"
apk add "$package"
if [ "$scope" = full ]; then
  /etc/init.d/zen-traffic enable
  /etc/init.d/zen-traffic restart
  /usr/libexec/zen-traffic-check
fi
