# Native Overcooked controller app

This is a binary extension of the backed-up stock firmware, not a replacement
firmware or a source rebuild. It is pinned to `v0.1.2-392-gd3089c4` and the
exact factory partition in this repository's two backups.

## Build and check

From the repository root, with Python and Zig 0.14.1 installed:

```powershell
python badge/native/build.py
python badge/native/test_build.py
python badge/native/test_payload.py
python badge/native/ble_receiver.py --self-test
python -m esptool --chip esp32c3 image-info badge/native/build/overcooked-factory.bin
```

`build.py` defaults to the repository-local Windows Zig path. On another host,
pass it explicitly, for example `python badge/native/build.py --zig /path/to/zig`.

The local compiler can be installed with
`python -m pip install --target .tools/native ziglang==0.14.1`.
The compiled-callback tests use
`python -m pip install --target .tools/reverse unicorn==2.1.4`.
Those tests emulate the RISC-V payload with firmware calls stubbed; they do
not simulate actual BLE, LVGL, flash, or the stock registry.
No full ESP-IDF installation or original firmware source is required to build
this extension. The extension calls the existing firmware's compiled APIs.

Outputs under ignored `build/`:

- `stock-factory.bin`: validated original application image.
- `stock-factory-partition.bin`: exact original factory partition, including
  trailing bytes, for rollback at the same factory offset.
- `overcooked.elf`: native payload with fixed text and constant addresses.
- `overcooked-factory.bin`: factory-only candidate.
- `verification.json`: sizes, hashes, hook bytes, and static verification results.

The original app descriptor stays intact; it still reports the stock version
and ELF hash. Identify the modified image by its SHA-256 and `OC_NATIVE` logs,
not by that unchanged descriptor.

## Supported deployment and role selection

The v1 low-memory profile is one native factory image on **all four badges**:
one host and three players. It is the supported response to the observed host
NimBLE OOM and player Lua-allocation failure. The existing `master/` and
`slave/` Lua apps remain in the repository and in LittleFS; they are the
explicit unmodified-firmware rollback profile, not deleted assets.

Do not mix profiles within a round. Native mode preserves the current OC1
application payloads, but calls the stock advertising HAL directly. Lua
`badge.radio` adds and filters its private `LUA1` carrier prefix, so a Lua host
cannot hear a native player and a native host cannot hear a Lua player.

Boot logs `OC_NATIVE|registered`. Overcooked appears as a native launcher app
with target ID `overcooked`. Selecting it takes the stock clean-reboot path,
which is the memory-critical difference from launching either Lua app.

1. On each of the three player badges, open **Overcooked**, press **A**, choose a
   unique fixed number 1–3 with LEFT/RIGHT, then press **A** to confirm. Radio
   and NFC start only after confirmation.
2. On the USB-connected gateway badge, open **Overcooked** and press **START**
   to choose host mode. Host mode starts radio without NFC and emits
   `HTN26|GW|UP|0|0` on success or `HTN26|GW|DOWN|0|0` on failure.
3. After all players show waiting state, press **START** again on the host. It
   logs `HTN26|GAME|START_GAME|120|3`, broadcasts `OC1|000001|G|S`, counts down
   two minutes, then logs `HTN26|GAME|GAME_END|3` and broadcasts the matching
   end control. Events before start are ignored.

The app draws held state, plate contents, selection, stoves, radio status, and
controls. Radio initialization has a fail-closed NVS preflight and never invokes
the stock erase/recovery branch. The player role then enables NFC; the host
role does not. Program the four NDEF Text tags as `pantry`, `fridge`,
`cutting board`, and `stove`.

- LEFT/RIGHT + pantry: lettuce/bread; LEFT/RIGHT + fridge: meat/cheese.
- DOWN + pantry takes a plate with an empty hand or a prepared held item.
- Prepared pickups go directly onto a held plate; duplicates and raw items are rejected.
- Hold A + cutting board chops meat, lettuce, or cheese; releasing A resets progress.
- LEFT/RIGHT + stove selects stove 1/2, then puts, checks, or takes meat.
- Hold B + shake discards; hold A + shake submits the plate. A shake without
  either button broadcasts `READY` for Pi-side team submission consensus.
- Bump two badges to merge a platable hand item onto the other plate, or swap
  inventories when that merge is invalid or both badges have the same plate state.

Invalid station/button combinations show `UNKNOWN BUTTON COMBO` and red LEDs
for one second. Meat cooks for 15 seconds, is done for two, flashes a three-second
warning, then burns. The six LEDs also show cutting and stove progress. Only
the native host acknowledges player actions, so a player makes at most three
identical attempts until the single-Pi gateway has observed the event. The host
logs each unique event as one `HTN26|RX|...` record and emits periodic gateway
health. The badge tracks immediate controller feedback, while the Pi/web app
remains authoritative for players, orders, scoring, penalties, and the
simultaneous-submit window.
See `RADIO_PROTOCOL.md` for packet format, recovered HAL calls, LED meanings,
and the Windows test peer.

Serial heap measurements include internal 8-bit memory (mask 0x804) and
default memory (mask 0x1000), at entry, before radio, after radio, exit, and
every 250 ticks while idle. The nominal tick interval is 20 ms. The permanent
app object is 300 bytes, excluding allocator, registry, and launcher overhead.
LVGL allocations belong to the app screen and are reclaimed by stock code.

Home uses stock registry exit handling. The app stops the radio; the registry
then cleans the screen and reboots with `focus=overcooked` when radio/NFC was
active. If initialization failed before becoming active, stock behavior may
return directly to the launcher without rebooting. Persistence failure also
retains the stock direct-launch fallback.

## Backup, factory-only flash, and rollback gate

Offline checks do not authorize a flash or establish runtime acceptance. Repeat
this procedure separately for each badge, substituting its port and a unique
backup directory. Never run `erase-flash`, never write a merged/full image, and
never change secure-boot, flash-encryption, security configuration, or eFuses.
Read security state only with the esptool version's `get-security-info` command.
If it differs from the inspected disabled state, stop rather than changing it.

Before any write, put the badge in its established bootloader mode and take a
fresh backup while keeping it there:

```powershell
New-Item -ItemType Directory -Force badge-backup
python -m esptool --chip esp32c3 --port COM4 --before no-reset --after no-reset get-security-info
python -m esptool --chip esp32c3 --port COM4 --before no-reset --after no-reset read-flash 0x0 0x400000 badge-backup/full-before.bin
python -m esptool --chip esp32c3 --port COM4 --before no-reset --after no-reset read-flash 0x8000 0x1000 badge-backup/partition-table-before.bin
python -m esptool --chip esp32c3 --port COM4 --before no-reset --after no-reset read-flash 0x10000 0x2A0000 badge-backup/factory-before.bin
```

Verify the partition table and factory hashes against the builder's pinned
inputs before proceeding. Preserve all three files off the badge. Then write
**only** the factory application and read it back before booting:

```powershell
python -m esptool --chip esp32c3 --port COM4 --baud 460800 --before no-reset --after no-reset write-flash 0x10000 badge/native/build/overcooked-factory.bin
python -m esptool --chip esp32c3 --port COM4 --before no-reset --after no-reset read-flash 0x10000 0x2A0000 badge-backup/factory-after.bin
```

The write command supplies no bootloader, partition table, NVS, PHY, or storage
image. Confirm the candidate/readback bytes and that the sector-rounded end is
below storage at `0x2B0000` before booting.

Rollback is also factory-only. Return the badge to bootloader mode and write the
fresh per-device pre-write factory copy (or the builder's byte-identical pinned
`stock-factory-partition.bin` after verifying its hash), then read it back:

```powershell
python -m esptool --chip esp32c3 --port COM4 --baud 460800 --before no-reset --after no-reset write-flash 0x10000 badge-backup/factory-before.bin
python -m esptool --chip esp32c3 --port COM4 --before no-reset --after no-reset read-flash 0x10000 0x2A0000 badge-backup/factory-rollback-readback.bin
```

Rollback leaves LittleFS/storage untouched, so the Lua `master` and `slave`
apps remain available. Roll back all four badges together and select **HTN26
Host** on the gateway plus **HTN26 Player** on each player; do not create a mixed
round.

## Physical acceptance still required

The current role-selection, Lua-compatible payload, gateway-only ACK, exact
lifecycle records, and host-without-NFC changes have offline build/emulator
coverage only. Physical acceptance still requires all four badges and the Pi:
cold boot; unique player selection; host `GW|UP`; start/end on every player;
NFC, chop, stove, transfer, three-shake submission; deduped USB serial ingestion;
several minutes of stable heap logs; repeated Home/reentry; and My Badge, Share,
Sync, and installed-Lua regression checks. Also calibrate shake/tap thresholds
and stove timing on-device. Share transfer and full Sync need their real peer or
station. Do not claim the supplied OOM is resolved on hardware until this gate
passes.

One static integration boundary remains outside this badge-memory change. The
Pi transport parsers now retain the current fixed-player `E|P<player>:<action>`
record unchanged, but the portable C++ master is still its documented legacy
tomato-soup fixture and does not apply the burger action vocabulary. This does
not prevent measuring native BLE/heap or serial forwarding, but it does prevent
claiming full authoritative Pi/UI gameplay until the existing Pi adapter seam is
implemented and validated on QNX.

See `../NATIVE_INVESTIGATION.md` for recovered interfaces and NVS recovery
behavior. The addresses are private ABI details, not a stable SDK.
See `HARDWARE_RESULTS.md` for measured results and remaining physical checks.
`verification.json` reports only the offline build; its `hardware_tested` field
stays false because the builder itself never accesses hardware.
