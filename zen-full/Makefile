include $(TOPDIR)/rules.mk

PKG_NAME:=zen-full
PKG_VERSION:=0.2.1
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0

include $(INCLUDE_DIR)/package.mk

define Package/zen-full
  SECTION:=luci
  CATEGORY:=LuCI
  TITLE:=Zen theme and eBPF traffic suite
  DEPENDS:=+luci-theme-zen +luci-app-zen-traffic +zen-traffic
  PKGARCH:=all
endef

define Build/Compile
endef

define Package/zen-full/install
	$(INSTALL_DIR) $(1)/usr/share/zen
	printf '%s\n' 'Zen theme and eBPF traffic suite' > $(1)/usr/share/zen/full
endef

$(eval $(call BuildPackage,zen-full))
