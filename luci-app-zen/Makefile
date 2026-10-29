include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-zen
PKG_VERSION:=0.2.4
PKG_RELEASE:=2

PKG_MAINTAINER:=luci-zen maintainers
PKG_LICENSE:=Apache-2.0
PKG_LICENSE_FILES:=LICENSE
PKG_BUILD_DEPENDS:=luci-base/host ucode/host

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-zen
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=Zen - LuCI network console
  PROVIDES:=luci-theme-zen luci-app-zen-traffic zen-full
  DEPENDS:=+luci-zen +luci-base +ucode +ucode-mod-fs +ucode-mod-uci +ucode-mod-ubus +rpcd-mod-iwinfo +curl +ca-bundle
  PKGARCH:=all
endef

define Package/luci-app-zen/conffiles
/etc/config/zen
endef

define Package/luci-app-zen/description
  Zen network console for OpenWrt 25.x (apk, ucode + native JS, no Lua).
  ucode + native JS, no Lua runtime. Light/dark, reduced-motion aware.
  Overview dashboard: system gauges, network status, realtime traffic.
  Includes traffic history, notifications, device controls, menus and translations.
  The luci-zen package provides the separate traffic backend (zen.traffic).
endef

define Build/Prepare
endef

define Build/Configure
endef

# 中文语言包随主题安装。po2lmo 由 luci-base/host 提供，使用 SDK 的工具 PATH。
# 工具或翻译转换失败时必须报错，避免发布缺少语言包的主题。
define Build/Compile
	mkdir -p $(PKG_BUILD_DIR)
	# Compile templates before packaging; defer the target-only LuCI module.
	for template in $(CURDIR)/ucode/template/themes/zen/*.ut; do \
		$(STAGING_DIR_HOSTPKG)/bin/ucode -T -c,dynlink=luci.core,dynlink=uci -o /dev/null "$$$$template" || exit $$$$?; \
	done
	po2lmo $(CURDIR)/po/zh_Hans/theme.po $(PKG_BUILD_DIR)/zen.zh-cn.lmo
	po2lmo $(CURDIR)/po/zh_Hans/zen-traffic.po $(PKG_BUILD_DIR)/zen-traffic.zh-cn.lmo
	for script in $(CURDIR)/root/usr/share/zen/*.uc; do \
		$(STAGING_DIR_HOSTPKG)/bin/ucode -c,dynlink=fs,dynlink=uci,dynlink=ubus -o /dev/null "$$$$script" || exit $$$$?; \
	done
endef

define Package/luci-app-zen/install
	$(INSTALL_DIR) $(1)/www/luci-static/zen
	$(INSTALL_DATA) ./htdocs/luci-static/zen/cascade.css $(1)/www/luci-static/zen/cascade.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/mobile.css $(1)/www/luci-static/zen/mobile.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/theme.css $(1)/www/luci-static/zen/theme.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/preferences.js $(1)/www/luci-static/zen/preferences.js
	$(INSTALL_DATA) ./htdocs/luci-static/zen/custom.css $(1)/www/luci-static/zen/custom.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/console.css $(1)/www/luci-static/zen/console.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/console-workspace.css $(1)/www/luci-static/zen/console-workspace.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/console-layout.js $(1)/www/luci-static/zen/console-layout.js
	$(INSTALL_DATA) ./htdocs/luci-static/zen/device-controls.css $(1)/www/luci-static/zen/device-controls.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/logo.svg $(1)/www/luci-static/zen/logo.svg
	$(INSTALL_DIR) $(1)/usr/share/licenses/luci-app-zen
	$(INSTALL_DATA) ./THIRD_PARTY_NOTICES.md $(1)/usr/share/licenses/luci-app-zen/THIRD_PARTY_NOTICES.md

	$(INSTALL_DIR) $(1)/www/luci-static/resources
	$(INSTALL_DATA) ./htdocs/luci-static/resources/menu-zen.js $(1)/www/luci-static/resources/menu-zen.js

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/zen
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen/*.js $(1)/www/luci-static/resources/view/zen/

	$(INSTALL_DIR) $(1)/usr/share/ucode/luci/template/themes/zen
	$(INSTALL_DATA) ./ucode/template/themes/zen/header.ut $(1)/usr/share/ucode/luci/template/themes/zen/header.ut
	$(INSTALL_DATA) ./ucode/template/themes/zen/footer.ut $(1)/usr/share/ucode/luci/template/themes/zen/footer.ut
	$(INSTALL_DATA) ./ucode/template/themes/zen/sysauth.ut $(1)/usr/share/ucode/luci/template/themes/zen/sysauth.ut

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./root/etc/config/zen $(1)/etc/config/zen
	$(INSTALL_BIN) ./root/etc/uci-defaults/30_luci-theme-zen $(1)/etc/uci-defaults/30_luci-theme-zen
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd $(1)/usr/share/zen
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/zen.update $(1)/usr/libexec/rpcd/zen.update
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/zen.device $(1)/usr/libexec/rpcd/zen.device
	$(INSTALL_DATA) ./root/usr/share/zen/*.uc $(1)/usr/share/zen/

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-theme-zen.json $(1)/usr/share/rpcd/acl.d/luci-theme-zen.json
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-theme-zen.json $(1)/usr/share/luci/menu.d/luci-theme-zen.json

	$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/zen.zh-cn.lmo $(1)/usr/lib/lua/luci/i18n/zen.zh-cn.lmo

	$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/zen-traffic.zh-cn.lmo $(1)/usr/lib/lua/luci/i18n/zen-traffic.zh-cn.lmo

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/zen-traffic
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/analysis-workspace.js $(1)/www/luci-static/resources/view/zen-traffic/analysis-workspace.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/app-usage.js $(1)/www/luci-static/resources/view/zen-traffic/app-usage.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/date-picker.js $(1)/www/luci-static/resources/view/zen-traffic/date-picker.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/device-reset.js $(1)/www/luci-static/resources/view/zen-traffic/device-reset.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/notification-settings.js $(1)/www/luci-static/resources/view/zen-traffic/notification-settings.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/style.js \
		$(1)/www/luci-static/resources/view/zen-traffic/style.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/history.js \
		$(1)/www/luci-static/resources/view/zen-traffic/history.js

	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/rate-history.js \
		$(1)/www/luci-static/resources/view/zen-traffic/rate-history.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen-traffic/device-timeline.js \
		$(1)/www/luci-static/resources/view/zen-traffic/device-timeline.js
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

define Package/luci-app-zen/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache /tmp/luci-modulecache/* 2>/dev/null
	/etc/init.d/rpcd reload >/dev/null 2>&1 || true
}
exit 0
endef

define Package/luci-app-zen/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	uci -q delete luci.themes.Zen && uci -q commit luci
	rm -f /tmp/luci-indexcache /tmp/luci-modulecache/* 2>/dev/null
}
exit 0
endef

$(eval $(call BuildPackage,luci-app-zen))
