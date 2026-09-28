# luci-zen · zen-trafficd-spike — OpenWrt/ImmortalWrt SDK 包（Rust feasibility spike）
#
# 用法（README.md §Step 1）：
#   把 poc/rust-spike 整个目录拷贝为 SDK 的 package/zen-trafficd-spike/
#   （包根 = 本文件所在目录 = Cargo workspace 根，Build/Prepare 默认整目录拷入）
#   然后在 SDK 根目录：
#       ./scripts/feeds update base packages
#       ./scripts/feeds install rust libubus libubox
#       make defconfig
#       make package/zen-trafficd-spike/{clean,compile} V=s
#
# 说明：
#   - rust-package.mk 由 packages feed 提供（官方模式，参考 openwrt/packages
#     utils/arp-whisper：RustBinPackage + RUST_ARCH_DEPENDS）
#   - 产物 binary 与 map 产物（.bpf.o）分离：本包只编译用户态 daemon；
#     zen_traffic.bpf.o 由 scripts/build-bpf.sh（clang -target bpf）单独产出
#   - C PoC（poc/src/zen-trafficd-poc.c）保留不动，作为行为对照

include $(TOPDIR)/rules.mk

PKG_NAME:=zen-trafficd-spike
PKG_VERSION:=0.0.1
PKG_RELEASE:=1
PKG_MAINTAINER:=luci-zen
PKG_LICENSE:=GPL-2.0

PKG_BUILD_DEPENDS:=rust/host
PKG_BUILD_PARALLEL:=1
RUST_PKG_LOCKED:=0

include $(INCLUDE_DIR)/package.mk
include $(TOPDIR)/feeds/packages/lang/rust/rust-package.mk

define Package/zen-trafficd-spike
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=zen-traffic daemon (Rust/Aya feasibility spike)
  DEPENDS:=$(RUST_ARCH_DEPENDS) +libubus +libubox
endef

define Package/zen-trafficd-spike/description
  Feasibility spike for the Rust rewrite of zen-trafficd:
  Aya loads zen_traffic.bpf.o (TC ingress/egress, devices map),
  publishes ubus object "zen.traffic" (ping/stats) on uloop.
  Spike only - not for production.
endef

# build.rs 通过 UBUS_LIB_DIR 找 staging 里的 libubus/libubox
export UBUS_LIB_DIR:=$(STAGING_DIR)/usr/lib

# 安装：rust-package.mk 不同版本的目标三元组目录命名有差异，
# 用 find 兜底定位产物（spike 用法，正式包改回精确路径）
define Package/zen-trafficd-spike/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) \
		$$(find $(PKG_BUILD_DIR)/target -type f -name zen-trafficd-spike -perm -u+x | head -n1) \
		$(1)/usr/bin/
endef

$(eval $(call RustBinPackage,zen-trafficd-spike))
$(eval $(call BuildPackage,zen-trafficd-spike))
