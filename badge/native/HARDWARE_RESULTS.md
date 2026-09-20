# Native shell hardware validation

Test date: 2026-09-19. Device: ESP32-C3 revision 0.4, COM4.
This is a compiled native extension of the exact stock binary, not a rebuild
of unavailable stock source. No original ESP-IDF project was recovered.

## Image and preservation

Milestone 1 candidate (archived): `build/milestone1/overcooked-factory.bin`, 2,718,448 bytes.
Factory capacity: 2,752,512 bytes; remaining: 34,064 bytes.
SHA-256: `e2f2de744e9b86a59c6f28b3380ea9485ad4c49148b8ac04e03349a3de5057d3`.

The original factory partition and partition table matched the supplied dumps.
Security inspection reported secure boot and flash encryption disabled.
No eFuses or security settings were changed.

Executed write command:

```powershell
python -m esptool --chip esp32c3 --port COM4 --baud 460800 --before no-reset --after no-reset write-flash 0x10000 badge/native/build/overcooked-factory.bin
```

Full 4 MiB reads immediately before and after writing, with no intervening
application boot, proved:

- The candidate image read back byte-for-byte.
- Every byte outside factory stayed identical, including NVS, PHY, LittleFS,
  bootloader, partition table, and unused flash.
- The sector-rounded write ended at `0x2A8000`, below storage at `0x2B0000`.
- The remaining factory tail stayed identical.

Evidence: ignored local `build/flash-before.bin`, `build/flash-after.bin`,
`build/readback-verification.json`, and `build/flash-write.log`.
The exact original factory partition is retained as
`build/stock-factory-partition.bin` for rollback at `0x10000` only.
Runtime use subsequently writes normal stock configuration, including consumed
reboot intents; the byte-identity claim above applies to the flash operation.

## Initial runtime results

Cold hardware reset loaded the patched image, logged `OC_NATIVE|registered`,
opened My Badge, and listed all stock apps plus the four installed Lua apps.
The native `overcooked` ID is separate from Lua `overcooked_badge`.
The logged badge identity matched the stock baseline.

Software reboot with stock target `overcooked` entered the native app directly.
The existing HAL reported `BLE radio ready`; its result was 0.
The UI tree showed OVERCOOKED, Radio ready / Native client idle, and HOME: Apps.

| Measurement | Free bytes | Largest block |
| --- | ---: | ---: |
| Original Share after entry, registry | 75,516 | 65,536 |
| Original Share before radio, HAL | 71,908 | 59,392 |
| Original Share receive ready, console | 20,460 | 12,288 |
| Native Overcooked entry | 75,488 | 65,536 |
| Native Overcooked before radio | 75,488 | 65,536 |
| Native Overcooked immediately after radio | 22,396 | 14,336 |
| Native Overcooked initial idle | 20,876 | 8,192 |

The new app costs 28 bytes of system heap at entry relative to original Share.
Overcooked starts radio before the console finishes startup; Share's receive
action starts afterward. Compare entry overhead directly, but do not attribute
all before/after-radio differences to the app. The two apps also use different
radio activity: Share receive pauses advertising, while Overcooked uses the
HAL's default advertising and scanning. Both heap capability masks logged by
Overcooked (0x804 and 0x1000) returned equal values in these samples.

Evidence: `build/stock-share-entry.txt`, `build/stock-share-radio.txt`,
`build/native-boot.txt`, and `build/native-entry.txt`.

## Known stock diagnostic fault

Invoking console `radio` before radio initialization caused a Load access fault
on the unmodified stock firmware. Normal Share receive initialization worked.
The native app uses the HAL entry point, not that diagnostic command.
This unrelated stock fault was not changed.

## Soak and launcher lifecycle

The user confirmed the physical display was correct and tested Home. Logs
captured radio shutdown, software reboot, and launcher focus `overcooked`.
That first soak ended through the user's Home press, not a crash.

A subsequent uninterrupted 180-second soak captured 36 idle samples:
free heap 20,704–20,740 bytes, largest block consistently 8,704 bytes.
There was no panic, exit, or unexpected reset. This establishes short idle
stability; it is not a long-duration or networking-load test.

Launcher A selection logged `reboot-enter overcooked`, then a direct native
boot and successful BLE initialization. Two additional automated Home/A cycles
verified radio shutdown, reboot to focused launcher, and successful radio
initialization on reentry. No firmware changes were needed after first flash.

Evidence: `build/native-soak.txt`, `build/native-soak-uninterrupted.txt`,
`build/native-soak-summary.json`, `build/native-launcher-entry.txt`, and
`build/native-cycles.txt`. The user also confirmed the first Home press.

## Stock application smoke checks

- My Badge opened after hardware reset with the same logged identity.
- Share entered Receive, initialized BLE, displayed WAITING, and returned through
  a clean reboot to launcher focus `share`. Its ready heap was 20,444 bytes
  versus 20,460 bytes in the original-stock sample.
- Sync initialized BLE, displayed “looking for a station...”, and returned through
  a clean reboot to launcher focus `sync`.
- Existing Lua Bullet Dodge launched through the normal launcher, displayed its
  game screen, accepted A and Right input without reported errors, and returned
  to the launcher with Home. All four installed Lua apps remained registered;
  only Bullet Dodge was exercised as a normal Lua runtime smoke check.

Evidence: `build/regression-share.txt`, `build/regression-sync.txt`, and
`build/regression-lua-launcher.txt`.

## 2026-09-20 icon-build boot-loop repair

The first icon build exceeded the stock runtime's mapped DROM window even
though it still fit the factory partition. On COM7 this faulted while reading
the native registration log and reset before the launcher appeared. Native
icons were reduced to 28x28 and the build now rejects `.rodata` beyond
`0x3c270000` (30,880 bytes from the payload base).

The repaired image SHA-256 is
`952664d4abbd7a9e247ae50e8c9cfea0b4662ff276335ba27f218d96a53e6d80`.
A full-chip readback matched the candidate in the factory range and remained
byte-identical to the pre-repair backup outside that range. COM7 then booted My
Badge, launched the native Overcooked host screen, exited cleanly, rebooted,
and returned to the launcher focused on Overcooked without a panic.

Evidence: `badge-backup/COM7-bootloop-before.bin`,
`badge-backup/COM7-bootloop-factory.bin`, and
`badge-backup/COM7-bootloop-repaired-full.bin`. This validates one physical
badge. A second physical badge on COM6 (MAC `e8:f6:0a:28:eb:4c`) received the
same image: full-chip readback verified the factory image and preserved every
byte outside the factory partition, then it booted My Badge and entered the
launcher with its original identity. Its rollback images are under
`badge-backup/COM6-20260920-repair/`. Further badges still need the same
per-device deployment and smoke check.

COM5 (MAC `e8:3d:c1:29:86:f4`) was also flashed and read back successfully;
its personal storage stayed byte-identical and it booted My Badge as Adeline
Lue Sang. Its rollback images are under `badge-backup/COM5-20260920-repair/`.

An additional test forced `target=bullet_dodge` on reboot. That path hit a
`Stack protection fault` in the 4 KiB main task before app entry completed.
It is distinct from the working normal launcher path, which invokes Lua from
the larger LVGL task. This forced-boot failure was not compared against the
original image, so it is not classified as either pre-existing or a regression.
No Lua or stock boot code was changed to accommodate it. Evidence:
`build/regression-lua.txt`. Do not use the native clean-boot test procedure as
a general Lua launch procedure.

## Remaining gates

Actual Share transfers need another badge; full Sync needs a compatible station.
Neither is established by opening those screens. A power-disconnect cold boot,
long-duration soak, and broader stock-app checks remain physical acceptance work;
the recorded cold reset used USB/JTAG hardware reset rather than removing power.
These are Milestone 1 results. Subsequent PING/PONG implementation and testing
are documented in `RADIO_PROTOCOL.md` and `MILESTONE2_RESULTS.md`. NFC, gameplay,
and a server are still outside the native diagnostic app.
