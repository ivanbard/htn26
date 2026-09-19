# Native Overcooked controller app

This is a binary extension of the backed-up stock firmware, not a replacement
firmware or a source rebuild. It is pinned to `v0.1.2-392-gd3089c4` and the
exact factory partition in this repository's two backups.

## Build and check

From the repository root, with Python and the local Zig 0.14.1 tool installed:

```powershell
python badge/native/build.py
python badge/native/test_build.py
python badge/native/test_payload.py
python -m esptool --chip esp32c3 image-info badge/native/build/overcooked-factory.bin
```

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

## Expected behavior

Boot logs `OC_NATIVE|registered`. Overcooked appears as a native launcher app,
using the existing Share icon for this first shell. Selecting it uses the
stock clean-reboot policy and the target ID `overcooked`.

On launch, press A for a player badge or START for the host badge. Player
numbers come from each badge's advertising address. The host starts the
two-minute round with START, broadcasts `GAME:START`, shows the countdown,
then broadcasts `GAME:END`; both messages wipe round state. Gameplay input is
ignored outside an active round.

The app draws the held item, plate ownership/contents, selected direction,
both stoves, radio status, and controls. Its first tick checks NVS without erasing
it, then starts the existing native radio and NFC HALs.
NVS failure prevents radio initialization. Radio failure remains on screen
with serial diagnostics. Program the four NDEF Text tags as `pantry`, `fridge`,
`cutting board`, and `stove`.

- LEFT/RIGHT + pantry: lettuce/bread; LEFT/RIGHT + fridge: meat/cheese.
- DOWN + pantry takes a plate with an empty hand or a prepared held item.
- Prepared pickups go directly onto a held plate; duplicates and raw items are rejected.
- Hold A + cutting board chops meat or lettuce; releasing A resets progress.
- LEFT/RIGHT + stove selects stove 1/2, then puts, checks, or takes meat.
- Hold B + shake discards; hold A + shake submits the plate. A shake without
  either button broadcasts `READY` for Pi-side team submission consensus.
- Bump two badges to merge a platable hand item onto the other plate, or swap
  inventories when that merge is invalid or both badges have the same plate state.

Invalid station/button combinations show `UNKNOWN BUTTON COMBO` and red LEDs
for one second. Meat cooks for 15 seconds, is done for two, flashes a three-second
warning, then burns. The six LEDs also show cutting and stove progress. Every
action is acknowledged by a peer and logged as one
`HTN26|RX|...` frame; a sender makes at most three attempts. The badge tracks
immediate controller feedback, while the Pi/web app remains authoritative for
players, orders, scoring, penalties, and the simultaneous-submit window.
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

## Hardware gate

Do not mistake offline checks for runtime validation. Before flashing, read
device security information, verify current factory/partition data matches
the inspected backup, and retain fresh copies of protected partitions.
Do not change security configuration or eFuses.

The intended command, after those checks, writes only factory:

```powershell
python -m esptool --chip esp32c3 --port COM4 --baud 460800 --before no-reset --after no-reset write-flash 0x10000 badge/native/build/overcooked-factory.bin
```

It does not supply a bootloader, partition table, NVS, PHY, or storage image.
The byte range and sector-rounded end must remain below 0x2B0000. Do not use
a generic project flash target or merged full-flash image.
This exact command assumes the badge is already in its bootloader after the
pre-write backup. Keeping it there permits readback before application startup.

Physical acceptance: cold boot, launcher entry, native radio success, several
minutes of stable heap logs, repeated exit/reentry with focus restoration,
then My Badge/identity, Share transfer, Sync, and installed Lua app regression
checks. Actual Share/Sync transfer checks require a peer/station. Two-way
PING/PONG and the first event/ACK controller slice were proven on two badges.
The Update 1.1 NFC/accelerometer build requires physical acceptance. In
particular, calibrate the shake/tap thresholds and stove timing constants on-device.

See `../NATIVE_INVESTIGATION.md` for recovered interfaces and NVS recovery
behavior. The addresses are private ABI details, not a stable SDK.
See `HARDWARE_RESULTS.md` for measured results and remaining physical checks.
`verification.json` reports only the offline build; its `hardware_tested` field
stays false because the builder itself never accesses hardware.
