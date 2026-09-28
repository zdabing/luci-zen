# luci-zen · zen-traffic — 正式流量后台包（Rust/Aya + SQLite）
#
# 拷贝本目录为 SDK 的 package/zen-traffic/ 后：
#   ./scripts/feeds update base packages
#   ./scripts/feeds install rust libubus libubox clang bpf-headers
#   make defconfig
#   make package/zen-traffic/{clean,compile} V=s
#
# 组成：
#   - 用户态 daemon（RustBinPackage 模式，cargo 交叉编译，rusqlite bundled 需 target cc）
#   - zen_traffic.bpf.o（clang -target bpf，Build/Configure 阶段产出；
#     BPF 数据面与 poc/bpf/zen_traffic.bpf.c 同源，行为基线 A–H）
#   - init.d（procd + bpffs 自动挂载 + UCI→CLI）、UCI 配置、rpcd ACL
#
# 注意：luci-theme-zen 不依赖本包（运行时能力探测，ARCHITECTURE §4）。

include $(TOPDIR)/rules.mk

PKG_NAME:=zen-traffic
PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_MAINTAINER:=luci-zen maintainers
PKG_LICENSE:=GPL-2.0

PKG_BUILD_DEPENDS:=rust/host bpf-headers
PKG_BUILD_PARALLEL:=1
RUST_PKG_LOCKED:=0

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/bpf.mk
include $(TOPDIR)/feeds/packages/lang/rust/rust-package.mk

define Package/zen-traffic
  SECTION:=net
  CATEGORY:=Network
  TITLE:=zen-traffic device traffic daemon (eBPF + ubus + SQLite)
  DEPENDS:=$(RUST_ARCH_DEPENDS) +libubus +libubox +kmod-sched-bpf +kmod-sched
endef

define Package/zen-traffic/description
  Per-device traffic accounting via eBPF TC (MAC-keyed, LAN bridge hooks).
  Publishes ubus object "zen.traffic" (getDevices/getTotal/getHistory/...)
  consumed by luci-app-zen-traffic and probed by luci-theme-zen dashboard.
  SQLite persistence for daily/monthly usage (batched checkpoint, no
  per-second writes). No HTTP server, no TCP ports, no shell rpcd bridge.
endef

# ---- BPF 对象（Build/Configure：不干扰 RustBinPackage 的 Build/Compile）----
# bpf.mk 的 CompileBPF(src, extra_cflags) 产物固定为 <src>.o（llvm 全管线）；
# 内核 UAPI 取自 bpf-headers，含 -D__TARGET_ARCH_$(BPF_KARCH) 与字节序旗标。
BPF_SRC:=$(PKG_BUILD_DIR)/bpf/zen_traffic.bpf.c
BPF_OBJ:=$(PKG_BUILD_DIR)/bpf/zen_traffic.bpf.o

define Build/Configure
	$(call CompileBPF,$(BPF_SRC))
endef

# build.rs 经 UBUS_LIB_DIR 链接 staging 的 libubus/libubox
export UBUS_LIB_DIR:=$(STAGING_DIR)/usr/lib

define Package/zen-traffic/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) \
		$$(find $(PKG_BUILD_DIR)/target -type f -name zen-trafficd -perm -u+x | head -n1) \
		$(1)/usr/bin/

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

define Package/zen-traffic/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/zen-traffic enable 2>/dev/null || true
}
exit 0
endef

$(eval $(call RustBinPackage,zen-traffic))
$(eval $(call BuildPackage,zen-traffic))
