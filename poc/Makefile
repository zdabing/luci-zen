# luci-zen · Phase 0 eBPF PoC 构建
#
# 两种构建环境：
#  1) 开发机（Linux，x86_64 即可用于 x86 OpenWrt 目标/虚拟机测试）：
#       make
#     依赖：clang(BPF target)、libbpf-dev、libubus-dev/libubox-dev（或 OpenWrt staging）
#  2) OpenWrt SDK：
#       make LINUX_DIR=$(LINUX_DIR) STAGING_DIR=$(STAGING_DIR) \
#            CC=$(TARGET_CC) CLANG=$(CLANG)
#     （正式包的 Package/zen-traffic Makefile 在 Phase B 提供，本 Makefile 仅 PoC 用）

CLANG ?= clang
CC    ?= gcc

BPF_CFLAGS ?= -O2 -g -target bpf

# Linux UAPI 头：开发机 /usr/include 已含 linux/*；SDK 内显式传 LINUX_DIR
ifdef LINUX_DIR
BPF_INC += -I$(LINUX_DIR)/include
ifdef LINUX_KARCH
BPF_INC += -I$(LINUX_DIR)/arch/$(LINUX_KARCH)/include
endif
BPF_INC += -idirafter$(LINUX_DIR)/include/uapi
endif

# libbpf（pkg-config 或 SDK staging）
LIBBPF_CFLAGS ?= $(shell pkg-config --cflags libbpf 2>/dev/null)
LIBBPF_LIBS   ?= $(shell pkg-config --libs libbpf 2>/dev/null || echo -lbpf)

# libubus / libubox（SDK staging 示例：
#   UBUS_INC=-I$(STAGING_DIR)/usr/include UBUS_LIBS=-L$(STAGING_DIR)/usr/lib -lubus -lubox）
UBUS_INC ?=
UBUS_LIBS ?= -lubus -lubox

DAEMON_CFLAGS = -O2 -Wall -Wextra

all: build/zen_traffic.bpf.o build/zen-trafficd-poc

build:
	mkdir -p build

build/zen_traffic.bpf.o: bpf/zen_traffic.bpf.c | build
	$(CLANG) $(BPF_CFLAGS) $(BPF_INC) -c $< -o $@
	@llvm-objdump -S $@ 2>/dev/null | head -40 || true

build/zen-trafficd-poc: src/zen-trafficd-poc.c | build
	$(CC) $(DAEMON_CFLAGS) $(LIBBPF_CFLAGS) $(UBUS_INC) -o $@ $< $(LIBBPF_LIBS) $(UBUS_LIBS)

clean:
	rm -rf build

.PHONY: all clean
