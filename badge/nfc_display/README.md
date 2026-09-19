# NFC Record Display

A minimal standalone `api=2` Hacker Badge Lua app. It enables the documented
`badge.nfc` reader, polls at a bounded interval, and displays the card UID plus
the first NDEF Text record returned by `badge.nfc.read_text()`. The badge Lua
API does not expose arbitrary NDEF record enumeration, so this example does not
invent a lower-level tag adapter.

## Hardware and runtime assumptions

- A 2026 Hacker Badge with the Lua badge runtime and NFC reader hardware.
- NFC is reader-only; the tag must contain an NDEF Text record for record text
  to be shown. Empty/non-text tags are reported as `EMPTY TAG`.
- The app uses only documented `badge.ui`, `badge.nfc`, `badge.led`,
  `badge.input`, and `badge.sys` APIs. NFC is enabled only while this app is
  foregrounded.
- A missing tag shows `NO TAG`. NFC startup, read, missing-UID, and malformed
  read results show a visible failure state. Repeated presentation of one UID
  is debounced until the tag is removed or **A** is pressed.

## Run on a badge

1. In the Badge IDE, save any existing app first.
2. Replace the IDE's `manifest.cfg` with `badge/nfc_display/manifest.cfg` and
   its `main.lua` with `badge/nfc_display/main.lua`. No extra files are needed.
3. Turn the badge off, connect a USB **data** cable, turn it on normally (do
   not hold Start), and close other serial connections.
4. Click **Connect**, choose **USB JTAG/serial debug unit (Espressif)**, then
   click **Push**.
5. Launch **NFC Record Display** from the badge launcher with **A**. Present a
   tag; press **A** to clear and scan again. **HOME** exits.

If the IDE has **Import app**, import the two app files using its normal app
workspace flow; otherwise use the two editor files above. The IDE uploader and
a physical badge are required for NFC hardware validation.

## Validation

From the repository root:

```text
python -m unittest discover -s badge/nfc_display/tests -p 'test_*.py' -v
```

This checks the manifest/API surface and runs `luac -p` syntax validation. A
physical badge, NFC tag, display rendering, and firmware NFC behavior remain
hardware-only validation requirements.
