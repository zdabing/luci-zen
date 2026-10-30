# luci-zen · zen-traffic — 正式流量后台包（Rust/Aya + SQLite）
#
# 拷贝本目录为 SDK 的 package/luci-zen/ 后：
#   ./scripts/feeds update base packages
#   ./scripts/feeds install rust libubus libubox clang bpf-headers
#   make defconfig
#   make package/luci-zen/{clean,compile} V=s
#
# 组成：
#   - 用户态 daemon（RustBinPackage 模式，cargo 交叉编译，rusqlite bundled 需 target cc）
#   - zen_traffic.bpf.o（clang -target bpf，Build/Configure 阶段产出）
#   - init.d（procd + bpffs 自动挂载 + UCI→CLI）、UCI 配置、rpcd ACL
#
# luci-app-zen 依赖本包；软件包名改变，服务名、UCI 配置和数据库路径保持兼容。

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-zen
PKG_VERSION:=0.2.4
PKG_RELEASE:=3
PKG_MAINTAINER:=luci-zen maintainers
PKG_LICENSE:=GPL-2.0 LGPL-3.0-or-later
PKG_LICENSE_FILES:=LICENSE appid/LICENSE.LGPL-3.0 appid/LICENSE.GPL-3.0
PKG_FIXUP:=autoreconf
NDPI_VERSION:=6.0
NDPI_SOURCE:=libndpi-$(NDPI_VERSION).tar.gz
# nDPI 6.0 requires an explicit usage mode; see appid/NOTICE. Downstream
# commercial builds can override this with their applicable upstream mode.
NDPI_LICENSE_TYPE?=NDPI_LICENSE_NOT_FOR_PROFIT_LGPL

PKG_BUILD_DEPENDS:=rust/host bpf-headers
PKG_BUILD_PARALLEL:=1
RUST_PKG_LOCKED:=0

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/bpf.mk
include $(TOPDIR)/feeds/packages/lang/rust/rust-package.mk
CONFIGURE_PATH:=nDPI-$(NDPI_VERSION)

# Pin the upstream release archive and verify its complete SHA256 digest.
# Build the separate recognition executable inside this APK, preserving the
# two-package distribution and keeping nDPI out of the GPL-2.0 daemon process.
define Download/ndpi
  FILE:=$(NDPI_SOURCE)
  URL:=https://codeload.github.com/ntop/nDPI/tar.gz/$(NDPI_VERSION)?
  HASH:=21fc40cab5505942c0b21d9bbaf73e9adf8162ddfe782e4cd072cab855a2eda9
endef
$(eval $(call Download,ndpi))

# Rust 会读取 bundled SQLite 静态库的符号；仅含 GCC LTO 中间码的对象
# 在此路径下可能丢失 sqlite3_* 符号。保留机器码和 LTO 数据，并在最终
# GCC 链接阶段启用 LTO 插件，不关闭 Rust 或 C LTO。
ifeq ($(CONFIG_USE_LTO),y)
  TARGET_CFLAGS := $(filter-out -fno-fat-lto-objects,$(TARGET_CFLAGS)) -ffat-lto-objects
  CARGO_RUSTFLAGS += -Clink-arg=-flto=auto -Clink-arg=-fuse-linker-plugin
endif

define Package/luci-zen
  PROVIDES:=zen-traffic
  SECTION:=net
  CATEGORY:=Network
  TITLE:=zen-traffic device traffic daemon (eBPF + ubus + SQLite)
  DEPENDS:=$(RUST_ARCH_DEPENDS) +libubus +libubox +kmod-sched-bpf +kmod-sched-core +curl +ca-bundle
endef

define Package/luci-zen/description
  Per-device traffic accounting via eBPF TC (MAC-keyed, LAN bridge hooks).
  Publishes ubus object "zen.traffic" (getDevices/getTotal/getHistory/...)
  consumed by the combined luci-app-zen frontend.
  SQLite persistence for daily/monthly usage (batched checkpoint, no
  per-second writes). No HTTP server, no TCP ports, no shell rpcd bridge.
endef

define Package/luci-zen/conffiles
/etc/config/zen-traffic
endef

# ---- BPF 对象（Build/Configure：不干扰 RustBinPackage 的 Build/Compile）----
# bpf.mk 的 CompileBPF(src, extra_cflags) 产物固定为 <src>.o（llvm 全管线）；
# 内核 UAPI 取自 bpf-headers，含 -D__TARGET_ARCH_$(BPF_KARCH) 与字节序旗标。
BPF_SRC:=$(PKG_BUILD_DIR)/bpf/zen_traffic.bpf.c
BPF_OBJ:=$(PKG_BUILD_DIR)/bpf/zen_traffic.bpf.o

define Build/Prepare
	$(call Build/Prepare/Default)
	$(CP) ./Cargo.toml ./crates ./bpf ./appid ./LICENSE $(PKG_BUILD_DIR)/
	tar -xzf $(DL_DIR)/$(NDPI_SOURCE) -C $(PKG_BUILD_DIR)
endef

define Build/Configure
	$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) -I$(STAGING_DIR)/usr/include \
		-c $(PKG_BUILD_DIR)/crates/zen-ubus-sys/abi-check.c -o $(PKG_BUILD_DIR)/ubus-abi-check.o
	$(call CompileBPF,$(BPF_SRC))
	$(call Build/Configure/Default,--with-only-libndpi --enable-static --disable-shared --disable-plugin-support --disable-global-context-support)
endef

define Build/Compile
	CFLAGS="$(TARGET_CFLAGS)" CPPFLAGS="$(TARGET_CPPFLAGS)" \
		$(MAKE) -C $(PKG_BUILD_DIR)/nDPI-$(NDPI_VERSION)/src/lib libndpi.a
	$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) \
		-DZEN_NDPI_LICENSE_TYPE=$(NDPI_LICENSE_TYPE) \
		-I$(PKG_BUILD_DIR)/nDPI-$(NDPI_VERSION)/src/include \
		$(PKG_BUILD_DIR)/appid/zen-appid.c $(PKG_BUILD_DIR)/nDPI-$(NDPI_VERSION)/src/lib/libndpi.a \
		$(TARGET_LDFLAGS) -lm -o $(PKG_BUILD_DIR)/zen-appid
	$(call Build/Compile/Cargo,crates/zen-trafficd)
endef

# build.rs 经 UBUS_LIB_DIR 链接 staging 的 libubus/libubox
export UBUS_LIB_DIR:=$(STAGING_DIR)/usr/lib

define Package/luci-zen/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/bin/zen-trafficd $(1)/usr/bin/
	$(INSTALL_DIR) $(1)/usr/libexec
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/zen-appid $(1)/usr/libexec/zen-appid
	$(INSTALL_BIN) ./files/usr/libexec/zen-traffic-check $(1)/usr/libexec/zen-traffic-check
	$(INSTALL_DIR) $(1)/usr/share/licenses/luci-zen
	$(INSTALL_DATA) ./appid/LICENSE.LGPL-3.0 ./appid/LICENSE.GPL-3.0 $(1)/usr/share/licenses/luci-zen/
	$(INSTALL_DATA) ./LICENSE ./appid/NOTICE $(1)/usr/share/licenses/luci-zen/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/nDPI-$(NDPI_VERSION)/README.license.md \
		$(1)/usr/share/licenses/luci-zen/NDPI-LICENSING

	$(INSTALL_DIR) $(1)/usr/share/zen-traffic
	$(INSTALL_DATA) $(BPF_OBJ) $(1)/usr/share/zen-traffic/zen_traffic.bpf.o

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/zen-traffic $(1)/etc/init.d/zen-traffic

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/zen-traffic $(1)/etc/config/zen-traffic

	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/zen-traffic.json \
		$(1)/usr/share/rpcd/acl.d/zen-traffic.json

	# 数据目录（SQLite db 默认路径；rootfs 只读时由用户经 UCI 改 db_path）
	$(INSTALL_DIR) $(1)/etc/zen-traffic
endef

define Package/luci-zen/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/zen-traffic enable 2>/dev/null || true
	/etc/init.d/zen-traffic restart || \
		logger -t zen-traffic 'Installed; service could not start. Run /usr/libexec/zen-traffic-check'
}
exit 0
endef

$(eval $(call RustBinPackage,luci-zen))
$(eval $(call BuildPackage,luci-zen))
