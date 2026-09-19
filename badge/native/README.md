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

The app draws a title, radio status, last packet/peer, and button instructions. Its first tick
checks NVS without erasing it, then starts the existing native radio HAL.
NVS failure prevents radio initialization. Radio failure remains on screen
with serial diagnostics. A sends one canonical `I:MEAT` badge event; the peer
acknowledges the matching decimal sequence and logs a single `HTN26|RX|...`
frame. A sender makes at most three attempts with the same packet. NFC, the Lua
VM, and authoritative game logic are not added yet.
See `RADIO_PROTOCOL.md` for packet format, recovered HAL calls, LED meanings,
and the Windows test peer.

Serial heap measurements include internal 8-bit memory (mask 0x804) and
default memory (mask 0x1000), at entry, before radio, after radio, exit, and
every 250 ticks while idle. The nominal tick interval is 20 ms. The permanent
app object is 148 bytes, excluding allocator, registry, and launcher overhead.
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
PING/PONG was proven on two badges before this controller slice. The event/ACK
protocol and serial frame still require physical acceptance before adding NFC.

See `../NATIVE_INVESTIGATION.md` for recovered interfaces and NVS recovery
behavior. The addresses are private ABI details, not a stable SDK.
See `HARDWARE_RESULTS.md` for measured results and remaining physical checks.
`verification.json` reports only the offline build; its `hardware_tested` field
stays false because the builder itself never accesses hardware.
