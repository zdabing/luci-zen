#!/bin/sh
# 编译 zen_traffic.bpf.o（与 poc/Makefile 的 BPF 规则同参数）。
# 依赖：clang（支持 -target bpf）；Linux UAPI 头。
#
#   开发机（有 /usr/include/linux）：          ./build-bpf.sh
#   SDK/内核树头文件：LINUX_DIR=... ./build-bpf.sh
set -e

DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)   # poc/rust-spike
BPF_C="$DIR/../bpf/zen_traffic.bpf.c"
OUT="${1:-$DIR/zen_traffic.bpf.o}"
CLANG="${CLANG:-clang}"

INC=""
if [ -n "$LINUX_DIR" ]; then
    INC="-I$LINUX_DIR/include"
    [ -n "$LINUX_KARCH" ] && INC="$INC -I$LINUX_DIR/arch/$LINUX_KARCH/include"
    INC="$INC -idirafter$LINUX_DIR/include/uapi"
fi

echo "[build-bpf] $CLANG -target bpf -O2 -g $INC -c $BPF_C -o $OUT"
"$CLANG" -O2 -g -target bpf $INC -c "$BPF_C" -o "$OUT"
llvm-objdump -S "$OUT" 2>/dev/null | head -5 || true
echo "[build-bpf] OK: $OUT"
