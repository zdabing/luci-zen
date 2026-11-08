# Third-party notices

Device vendor prefixes in `zen-vendors.js` are a filtered snapshot of factual
MA-L manufacturer assignments from the Wireshark manufacturer registry,
https://www.wireshark.org/download/automated/data/manuf (2026-10-05).
Only selected manufacturer assignments are bundled; no Wireshark code or logo
assets are included. MAC assignments identify manufacturers, not product models.

Selected application and device-brand SVG artwork is bundled unchanged from
https://github.com/aaANDkk/Qure_Style_SVG at revision
ba24af0de3e3ae827464e4c73fcfd9beb7118ed2. Qure style and referenced artwork:
Koolson / https://github.com/Koolson/Qure. The upstream Qure source notice
requires attribution and limits use to non-commercial learning and exchange.
These assets are not covered by this package's Apache-2.0 code license.
See `licenses/qure/` (installed under `/usr/share/licenses/luci-app-zen/qure/`)
for the asset manifest, upstream third-party notices and retained license texts.
Brand names and trademarks belong to their respective owners. Missing brand
artwork falls back to locally drawn text initials or device-type symbols.

Theme colors, display preferences and settings controls are implemented in
`theme.css` and `preferences.js`. The previous third-party appearance module
is no longer distributed. Existing LuCI copyright and license notices remain
in their respective source files.
