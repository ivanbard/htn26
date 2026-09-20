# Badge item icons

These checked-in pixel-art assets are the source artwork for the HTN26 burger
player display. They are quick held-item confirmations on a small dark screen;
the richer game presentation remains in `ui/`.

## Source constraints

- 42×42 RGBA PNG with transparent space outside the subject.
- Hard-edged, centred pixel art designed against a dark background.
- Shared small palette and enough margin to remain readable at badge scale.
- No station or item placeholder should be invented when source art is absent.

Completed source files:

| File | Game state |
| --- | --- |
| `ing_bun_top.png` | Bun top source layer |
| `ing_bun_bottom.png` | Bun bottom source layer |
| `ing_cheese.png` | Raw cheese |
| `ing_cheese_chopped.png` | Sliced cheese |
| `ing_lettuce.png` | Raw lettuce |
| `ing_lettuce_chopped.png` | Sliced lettuce |
| `ing_meat.png` | Raw meat |
| `ing_meat_chopped.png` | Chopped meat |
| `ing_meat_cooked.png` | Cooked meat |
| `ing_meat_burnt.png` | Burnt meat (temporary placeholder source) |
| `station_plate.png` | Held plate |

There is no source PNG for an empty hand. Empty is represented by hiding the
image while retaining the `HELD: EMPTY` label.

`ing_meat_burnt.png` is temporarily a byte-for-byte copy of
`ui/assets/ing_meat_cooked.png` from remote-main commit
`0822a84190e88651bb448d62bdaa1b80fba8d993` (SHA-256
`6703951618aa7391d2a505ac465294b223b4aa8c780cc73db012845064fe7430`).
It gives `BURNT_MEAT` an independent named generation source without inventing
artwork. Replace that file with the dedicated burnt artwork when it is supplied;
the generator and native state mapping do not need another transform change.

## Native production representation

`generate_native_icons.py` converts the PNGs to LVGL RGB565A8 pixel planes and
writes `badge/native/generated_icons.h`. The production native app links those
const bytes into its existing DROM growth page and reuses one LVGL image widget;
it does not depend on LittleFS image files or allocate one widget per pixel.

Run from the repository root after editing an asset:

```sh
python badge/assets/icons/generate_native_icons.py
python badge/assets/icons/generate_native_icons.py --check
```

`badge/native/build.py` runs `--check` and refuses a stale generated header. The
generator uses only the Python standard library and validates PNG dimensions,
format, filters, and CRCs.

Every non-bun descriptor uses its named source pixels directly. The only
derived image is deterministic:

- **Bun:** crop the visible top/bottom source layers, nearest-neighbour resize
them to 36×20 and 36×12, then stack them at `(3,5)` and `(3,25)` in a transparent
42×42 image.
The ten images contain 52,920 bytes of RGB565A8 pixels. `verification.json`
records the generated-header hash, total payload DROM, and remaining factory
capacity for each build. The pixels are flash-mapped const data, not 52,920
bytes in the 312-byte persistent app object. Build/emulator checks validate the
selected descriptors and capacity; they do not prove physical pixel rendering.

## Lua display-test representation

`generate_lua_carousel.py` separately downsamples the same PNGs to a 14×14
logical grid and embeds palette/index data in `badge/display-test/main.lua`.
That rollback-era diagnostic uses one reusable grid of 196 `badge.ui.box`
widgets because the Badge IDE has no documented multi-image upload path.

```sh
python badge/assets/icons/generate_lua_carousel.py
```

The Lua carousel is not the production native rendering path. Whether a Lua app
can upload and address several independently named `.bin` images remains
unverified and does not affect the native const descriptors.
