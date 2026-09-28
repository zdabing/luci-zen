include $(TOPDIR)/rules.mk

PKG_NAME:=luci-theme-zen
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_MAINTAINER:=luci-zen maintainers
PKG_LICENSE:=Apache-2.0

include $(INCLUDE_DIR)/package.mk

define Package/luci-theme-zen
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=4. Themes
  TITLE:=Zen - Apple-inspired LuCI theme
  DEPENDS:=+luci-base
  PKGARCH:=all
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

# i18n：翻译源为标准 .po；.lmo 由 SDK 构建流程用 luci-base 提供的官方
# po2lmo（$(STAGING_DIR_HOST)/bin/po2lmo，luci.mk 同款路径）生成；
# 工具不存在时静默跳过，包内不带 lmo（仅英文界面，不影响功能）。
define Build/Compile
	mkdir -p $(PKG_BUILD_DIR)
	if [ -x $(STAGING_DIR_HOST)/bin/po2lmo ]; then \
		$(STAGING_DIR_HOST)/bin/po2lmo \
			$(CURDIR)/po/zh_Hans/theme.po \
			$(PKG_BUILD_DIR)/theme.zh-cn.lmo; \
	fi
endef

define Package/luci-theme-zen/install
	$(INSTALL_DIR) $(1)/www/luci-static/zen
	$(INSTALL_DATA) ./htdocs/luci-static/zen/cascade.css $(1)/www/luci-static/zen/cascade.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/mobile.css $(1)/www/luci-static/zen/mobile.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/custom.css $(1)/www/luci-static/zen/custom.css
	$(INSTALL_DATA) ./htdocs/luci-static/zen/logo.svg $(1)/www/luci-static/zen/logo.svg

	$(INSTALL_DIR) $(1)/www/luci-static/resources
	$(INSTALL_DATA) ./htdocs/luci-static/resources/menu-zen.js $(1)/www/luci-static/resources/menu-zen.js

	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/zen
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen/sysauth.js $(1)/www/luci-static/resources/view/zen/sysauth.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen/dashboard.js $(1)/www/luci-static/resources/view/zen/dashboard.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen/zen-format.js $(1)/www/luci-static/resources/view/zen/zen-format.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen/zen-icons.js $(1)/www/luci-static/resources/view/zen/zen-icons.js
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zen/zen-devices.js $(1)/www/luci-static/resources/view/zen/zen-devices.js

	$(INSTALL_DIR) $(1)/usr/share/ucode/luci/template/themes/zen
	$(INSTALL_DATA) ./ucode/template/themes/zen/header.ut $(1)/usr/share/ucode/luci/template/themes/zen/header.ut
	$(INSTALL_DATA) ./ucode/template/themes/zen/footer.ut $(1)/usr/share/ucode/luci/template/themes/zen/footer.ut
	$(INSTALL_DATA) ./ucode/template/themes/zen/sysauth.ut $(1)/usr/share/ucode/luci/template/themes/zen/sysauth.ut

	$(INSTALL_DIR) $(1)/usr/share/ucode/luci-zen
	$(INSTALL_DATA) ./root/usr/share/ucode/luci-zen/zen-cache.uc $(1)/usr/share/ucode/luci-zen/zen-cache.uc

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./root/etc/uci-defaults/30_luci-theme-zen $(1)/etc/uci-defaults/30_luci-theme-zen

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-theme-zen.json $(1)/usr/share/rpcd/acl.d/luci-theme-zen.json

	$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n
	if [ -f $(PKG_BUILD_DIR)/theme.zh-cn.lmo ]; then \
		$(INSTALL_DATA) $(PKG_BUILD_DIR)/theme.zh-cn.lmo \
			$(1)/usr/lib/lua/luci/i18n/theme.zh-cn.lmo; \
	elif [ -f ./po/zh_Hans/theme.lmo ]; then \
		$(INSTALL_DATA) ./po/zh_Hans/theme.lmo \
			$(1)/usr/lib/lua/luci/i18n/theme.zh-cn.lmo; \
	fi
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
	uci -q delete luci.themes.Zen
	uci -q commit luci
	rm -f /tmp/luci-indexcache /tmp/luci-modulecache/* 2>/dev/null

	H=/usr/share/ucode/luci-zen/zen-cache.uc
	for P in /luci-static/zen /luci-static/resources/menu-zen.js /luci-static/resources/view/zen; do
		uci -q del_list uhttpd.main.ucode_prefix="$$P=$$H"
	done
	uci commit uhttpd
	/etc/init.d/uhttpd restart >/dev/null 2>&1 || true
}
exit 0
endef

$(eval $(call BuildPackage,luci-theme-zen))
