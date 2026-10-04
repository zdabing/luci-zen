include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-zen-traffic
PKG_VERSION:=0.2.0
PKG_RELEASE:=8

PKG_MAINTAINER:=luci-zen maintainers
PKG_LICENSE:=Apache-2.0
PKG_BUILD_DEPENDS:=luci-base/host

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
	mkdir -p $(PKG_BUILD_DIR)
	po2lmo $(CURDIR)/po/zh_Hans/zen-traffic.po $(PKG_BUILD_DIR)/zen-traffic.zh-cn.lmo
endef

define Package/luci-app-zen-traffic/install
	$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/zen-traffic.zh-cn.lmo $(1)/usr/lib/lua/luci/i18n/zen-traffic.zh-cn.lmo

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/zen-traffic
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/style.js \
		$(1)/www/luci-static/resources/view/zen-traffic/style.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/devices.js \
		$(1)/www/luci-static/resources/view/zen-traffic/devices.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/history.js \
		$(1)/www/luci-static/resources/view/zen-traffic/history.js

	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/realtime.js \
		$(1)/www/luci-static/resources/view/zen-traffic/realtime.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/rate-history.js \
		$(1)/www/luci-static/resources/view/zen-traffic/rate-history.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/notifications.js \
		$(1)/www/luci-static/resources/view/zen-traffic/notifications.js

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
