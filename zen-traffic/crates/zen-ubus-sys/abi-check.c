/* Compile against the target's installed headers; no executable is required.
 * Keep these checks paired with Rust's repr(C) declarations in src/lib.rs.
 * ubus_context is deliberately partial in Rust, so check its sock offset only.
 */
#include <stddef.h>
#include <libubus.h>

_Static_assert(sizeof(struct ubus_request) == (sizeof(void *) == 8 ? 104 : 60),
               "ubus_request size differs from Rust FFI");
_Static_assert(offsetof(struct ubus_request, priv) == (sizeof(void *) == 8 ? 96 : 56),
               "ubus_request.priv offset differs from Rust FFI");

#if __SIZEOF_POINTER__ == 8
_Static_assert(sizeof(struct ubus_method) == 48, "ubus_method ABI changed");
_Static_assert(offsetof(struct ubus_method, policy) == 32, "ubus_method.policy ABI changed");
_Static_assert(sizeof(struct ubus_object) == 120, "ubus_object ABI changed");
_Static_assert(offsetof(struct ubus_object, methods) == 104, "ubus_object.methods ABI changed");
_Static_assert(sizeof(struct ubus_object_type) == 32, "ubus_object_type ABI changed");
_Static_assert(offsetof(struct ubus_context, sock) == 80, "ubus_context.sock ABI changed");
_Static_assert(sizeof(struct uloop_fd) == 16, "uloop_fd ABI changed");
_Static_assert(sizeof(struct uloop_timeout) == 48, "uloop_timeout ABI changed");
_Static_assert(offsetof(struct uloop_timeout, time) == 32, "uloop_timeout.time ABI changed");
#endif
