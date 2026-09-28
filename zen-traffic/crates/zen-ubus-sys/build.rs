// 链接 libubus + libubox。
// 查找顺序：
//   1. env UBUS_LIB_DIR（OpenWrt SDK 包 Makefile 导出 = $(STAGING_DIR)/usr/lib）
//   2. 开发机默认搜索路径（/usr/lib 等，无需显式 search path）
use std::env;

fn main() {
    println!("cargo:rustc-link-lib=dylib=ubus");
    println!("cargo:rustc-link-lib=dylib=ubox");

    if let Ok(dir) = env::var("UBUS_LIB_DIR") {
        if !dir.is_empty() {
            println!("cargo:rustc-link-search=native={dir}");
        }
    }

    // 头文件不参与编译（无 bindgen），无需 UBUS_INC_DIR。
    // libubus/libubox 版本差异风险集中在结构体布局，已在 src/lib.rs 注释说明。
}
