Badge item icons — design brief
Pixel-art assets for the HTN26 player badge (burger level). Give this file to whoever or whatever is drawing the final art — it's the full spec, independent of any particular tool.

The badge screen is small, dark, and glanced at, not studied: these icons are quick "you just picked up X" confirmations, not the game's visual identity. The rich Overcooked-style presentation (player tokens, live positions, the goose line) lives in ui/, which has no format constraints. Keep that distinction in mind if a design feels like it wants more detail than this format can hold — it probably belongs in the UI instead.

Hard constraints (from badge/badge-app-guide.md)
Output size: 42×42 px, square. This is the one size the badge IDE's "Choose image" flow is documented to produce (icon.bin, 5,304 bytes, LVGL RGB565A8). Deliver art already square — the IDE crops a non-square source to a square before resizing, so an off-square source loses control over the framing.
Color depth: RGB565 (16-bit) + 8-bit alpha. Flat colors only; smooth gradients will visibly band once quantized. Hard edges, no anti-aliasing — soft edges blur into mush at this size and don't survive the color conversion cleanly anyway.
Transparent background outside the drawn shape (the alpha channel is real, use it).
Design against a dark background. The badge UI theme is dark with near-white text by default; avoid near-black fills that vanish into it.
Centered subject with padding. Don't draw edge-to-edge — leave a margin so cropping/scaling doesn't clip the art.
Readable at a glance. If the shape isn't obvious zoomed way out, it's too detailed for this format — simplify further.
One shared palette across the whole set (aim for ~3 colors per icon: fill, shadow/edge, highlight) so all the icons read as one visual family rather than ten unrelated pieces.
Storage budget
Each converted icon is ~5.3 KB. The app's total on-device storage quota is 64 KiB, shared with everything else the app saves (badge.store, badge.fs). Ten icons alone is ~53 KB — there's not much room left over.
If the app should also be shareable badge-to-badge over Bluetooth ("Share"), the cap there is stricter: 48 KiB total bundle, 16 files max. A full 10-icon set already exceeds that on its own, so treat share-ability as unlikely with the complete set; trim it if that matters.
If the budget gets tight, cut from the bottom of the priority list below, not evenly across it.
Icon list
File	Item	State	Priority	Status
ing_bun_top.png	Bun (top)	raw	required	drawn
ing_bun_bottom.png	Bun (bottom)	raw	required	drawn
ing_buns.png	Buns	raw, single-icon fallback	superseded by top/bottom pair above	placeholder still in place
ing_cheese.png	Cheese	raw	required	drawn
ing_lettuce.png	Lettuce	raw	required	drawn
ing_meat.png	Meat	raw	required	drawn
ing_cheese_chopped.png	Cheese	chopped	required	drawn
ing_lettuce_chopped.png	Lettuce	chopped	required	drawn
ing_meat_chopped.png	Meat	chopped	required	drawn
ing_meat_cooked.png	Meat	cooked (post-stove)	nice-to-have	drawn
station_plate.png	Serving plate	—	required	drawn
station_chop.png	Chopping board	—	required	not drawn yet — placeholder
station_stove.png	Stove	—	required	not drawn yet — placeholder
The bun ended up as a top/bottom pair instead of one ing_buns.png icon — that's a reasonable split (Overcooked-style bun halves), just note both need wiring into the Lua app in place of the single planned icon. station_chop.png and station_stove.png are still the original programmatic placeholders (see Reference set below); those two are the gap left to draw.

PNG → self-contained Lua carousel (preferred)
generate_lua_carousel.py downsamples the PNGs to 14×14 logical pixels and embeds compact palette/index data directly in badge/display-test/main.lua. The badge app renders one reusable grid of 196 badge.ui.box widgets, so only manifest.cfg and main.lua need to be copied into the Badge IDE.

Run from the repository root after changing any PNG:

python badge/assets/icons/generate_lua_carousel.py

This is the supported path for the display-test carousel because the IDE has no documented way to upload multiple arbitrary .bin files.

PNG → badge binary conversion (diagnostic)
png_to_bin.py converts each 42×42 RGBA PNG in this directory into the RGB565A8 .bin format the badge loads, writing output to bin/. Run it after adding or changing any icon:

python3 png_to_bin.py
This conversion is unverified against real badge firmware. The guide documents the pixel format and the exact final size (5,304 bytes for 42×42) for the one supported path — the IDE's own "Choose image" button — but not the file's byte-level header. png_to_bin.py's header is reconstructed from LVGL v8's public lv_img_dsc_t structure and lands exactly on the documented 5,304 bytes, and a self-decode round-trip confirms the pixel-packing logic is internally consistent (alpha matches exactly; color is off by at most 7/255 per channel, which is normal RGB565 quantization, not a bug). None of that proves the badge firmware's loader will accept these bytes — only testing one on a real badge does. Before relying on the batch, push bin/ing_cheese.bin (or any one file) onto a real badge and confirm badge.ui.image renders it. If it fails, the safer fallback is converting each PNG through the IDE's own "Choose image" flow by hand instead of trusting this script.

Open technical risk — verify before drawing the full set
The IDE's documented image pipeline converts one picture into one file, icon.bin, normally used as the app's launcher icon. Whether it can be pointed at other filenames — so the app ends up with ten distinct .bin assets instead of one — isn't documented and hasn't been tested on real hardware in this repo. Push one test icon through "Choose image" on a real badge first and confirm (a) it renders via badge.ui.image from Lua and (b) whether a second, differently-named image file can be added and converted the same way. That answer decides whether the full 10-icon plan is achievable as-is or needs a fallback (e.g. one shared image slot whose source file gets swapped, or fewer distinct icons with LED/label cues carrying the rest of the state).

Reference set
generate_icons.py and the *.png files next to it in this directory are a placeholder set built programmatically — each icon is a 14×14 grid of flat colors scaled up 3× for a crisp blocky look. They're a working reference for scale, palette discipline, and the transparent-background convention, and a safe fallback if hand-drawn art isn't ready in time. Overwrite any of them freely; keep the filenames above so nothing else that references them needs to change.