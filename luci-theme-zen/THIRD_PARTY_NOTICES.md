# Third-party appearance module

`htdocs/luci-static/zen/appearance.css` is copied unchanged from
[Sunny UI Design System](https://github.com/xudong7587/sunny-ui-design-system),
commit `2022afe9461b6fbc678f0b1ecb77adacf4f0ecfa`.
Upstream path: `skills/sunny-ui-design/assets/appearance/appearance.css`.

`appearance.js` adapts the palette data, appearance variable contract and contrast
calculation from the upstream `AppearancePicker.tsx` to native LuCI/browser JavaScript.
Both files are licensed **GPL-3.0-only**; the complete license is included in
`licenses/sunny-ui-GPL-3.0.txt`. Upstream identifies MediaIndex as the code's origin.

`appearance-zen.css` contains the host-specific selector and token mappings.
The pre-existing LuCI theme sources retain their existing Apache-2.0 notices.
The package metadata lists both licenses; this notice and the GPL text are installed
with the theme. No upstream React runtime or business API is included.
