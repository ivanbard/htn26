# HTN26 Asset Display Test

Standalone physical-badge carousel for the ten completed burger icons in
`../assets/icons/`. Press **A** for the next icon, **B** for the previous icon,
and **HOME** to exit.

The app draws the icons as a reusable 14x14 grid of coloured boxes. All icon
data is embedded in `main.lua`, so it does not need PNG or `.bin` files on the
badge.

## Regenerate after editing a PNG

From the repository root:

```powershell
python badge/assets/icons/generate_lua_carousel.py
```

The generator downsamples each 42x42 PNG to 14x14, builds a compact palette and
pixel map, and rewrites `badge/display-test/main.lua`. Do not hand-edit the
generated icon data.

## Files to place in the Badge IDE

The Badge IDE does not open this repository. It needs only these two text
files:

```text
manifest.cfg    <- badge/display-test/manifest.cfg
main.lua        <- badge/display-test/main.lua
```

Do not upload the PNGs, generated `.bin` files, Python generator, or this
README. **Choose image** is optional and only changes the launcher icon.

## Upload and run

1. Open the [Badge IDE](https://badge.hackthenorth.com/ide/) in desktop Chrome
   or Edge.
2. Replace the IDE's `manifest.cfg` and `main.lua` with the files above.
3. Turn the badge off, connect it with a USB data cable, and turn it on
   normally. Do not hold Start.
4. Click **Connect** and select **USB JTAG/serial debug unit / Espressif**.
5. Click **Push** and wait for completion.
6. Open **HTN26 Asset Test** from the launcher.

Expected first screen:

```text
ASSET 1 / 10
BUN - TOP
ing_bun_top.png
```

The app first builds 196 pixel widgets over several ticks, then draws the
bun-top icon centered at 84x84 pixels. The LEDs are dim blue. Press **A**
through all ten icons and **B** to move backward. Button input is ignored
briefly while the grid is building or repainting.

## Limits and troubleshooting

The app uses 196 box widgets plus four labels, below the 512-widget cap.
Widgets are created eight per tick and repainted sixteen per tick to avoid
long callbacks. The generated `main.lua` is about 6 KiB and has no external
runtime assets.

If the app shows an error card, record the exact IDE console traceback.
Physical-badge testing remains authoritative because the desktop harness does
not render widgets.
