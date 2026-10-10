include $(TOPDIR)/rules.mk

PKG_NAME:=luci-theme-zen
PKG_VERSION:=0.2.1
PKG_RELEASE:=2

PKG_MAINTAINER:=luci-zen maintainers
PKG_LICENSE:=Apache-2.0 GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE licenses/sunny-ui-GPL-3.0.txt
PKG_BUILD_DEPENDS:=luci-base/host ucode/host

include $(INCLUDE_DIR)/package.mk

define Package/luci-theme-zen
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=4. Themes
  TITLE:=Zen - Apple-inspired LuCI theme
  DEPENDS:=+luci-base
  PKGARCH:=all
endef

define Package/luci-theme-zen/conffiles
/etc/config/zen
endef

define Package/luci-theme-zen/description
  Apple-inspired LuCI theme for OpenWrt 25.x (apk, ucode + native JS, no Lua).
  ucode + native JS, no Lua runtime. Light/dark, reduced-motion aware.
  Overview dashboard: system gauges, network status, realtime traffic.
  Optional device-traffic module auto-enables when `zen-traffic` daemon
  (ubus object zen.traffic) is present - no hard dependency.
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
endef

define Package/luci-theme-zen/install
	$(INSTALL_DIR) $(1)/www/luci-static/zen
	$(INSTALL_DATA) ./htdocs/luci-static/zen/cascade.css $(1)/www/luci-static/zen/cascade.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/mobile.css $(1)/www/luci-static/zen/mobile.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/appearance.css $(1)/www/luci-static/zen/appearance.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/appearance-zen.css $(1)/www/luci-static/zen/appearance-zen.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/appearance.js $(1)/www/luci-static/zen/appearance.js
	$(INSTALL_DATA) ./htdocs/luci-static/zen/custom.css $(1)/www/luci-static/zen/custom.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/logo.svg $(1)/www/luci-static/zen/logo.svg
	$(INSTALL_DIR) $(1)/usr/share/licenses/luci-theme-zen
	$(INSTALL_DATA) ./THIRD_PARTY_NOTICES.md $(1)/usr/share/licenses/luci-theme-zen/THIRD_PARTY_NOTICES.md
	$(INSTALL_DATA) ./licenses/sunny-ui-GPL-3.0.txt $(1)/usr/share/licenses/luci-theme-zen/sunny-ui-GPL-3.0.txt

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

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-theme-zen.json $(1)/usr/share/rpcd/acl.d/luci-theme-zen.json
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-theme-zen.json $(1)/usr/share/luci/menu.d/luci-theme-zen.json

	$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/zen.zh-cn.lmo $(1)/usr/lib/lua/luci/i18n/zen.zh-cn.lmo
endef

define Package/luci-theme-zen/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache /tmp/luci-modulecache/* 2>/dev/null
	/etc/init.d/rpcd reload >/dev/null 2>&1 || true
}
exit 0
endef

define Package/luci-theme-zen/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	uci -q delete luci.themes.Zen && uci -q commit luci
	rm -f /tmp/luci-indexcache /tmp/luci-modulecache/* 2>/dev/null
}
exit 0
endef

$(eval $(call BuildPackage,luci-theme-zen))
