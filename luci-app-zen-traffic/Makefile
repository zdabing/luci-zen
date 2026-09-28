include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-zen-traffic
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_MAINTAINER:=luci-zen maintainers
PKG_LICENSE:=Apache-2.0

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-zen-traffic
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=Zen Traffic - device traffic view for zen-trafficd
  DEPENDS:=+zen-traffic +luci-base
  PKGARCH:=all
endef

define Package/luci-app-zen-traffic/description
  LuCI device-traffic page for the zen-traffic daemon: realtime per-device
  rates, daily/monthly usage, per-device history (getHistory), hostname
  override and per-device reset. Requires the zen-traffic backend package.
endef

define Build/Prepare
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/luci-app-zen-traffic/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/zen-traffic
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/devices.js \
		$(1)/www/luci-static/resources/view/zen-traffic/devices.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/history.js \
		$(1)/www/luci-static/resources/view/zen-traffic/history.js

	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-zen-traffic.json \
		$(1)/usr/share/luci/menu.d/luci-app-zen-traffic.json

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-zen-traffic.json \
		$(1)/usr/share/rpcd/acl.d/luci-app-zen-traffic.json

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./root/etc/uci-defaults/40_luci-app-zen-traffic \
		$(1)/etc/uci-defaults/40_luci-app-zen-traffic
endef

define Package/luci-app-zen-traffic/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache /tmp/luci-modulecache/* 2>/dev/null
}
exit 0
endef

$(eval $(call BuildPackage,luci-app-zen-traffic))
