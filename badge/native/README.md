# Native Overcooked controller app

This is the **production/live badge implementation**. It is a binary extension
of the backed-up stock firmware, not a replacement firmware or a source rebuild.
It is pinned to `v0.1.2-392-gd3089c4` and the exact factory partition in this
repository's two backups. The Lua host/player apps are whole-fleet rollback
assets only; never mix native and Lua radio profiles.

The current production game host is a laptop running the local server/UI with
the gateway badge attached over USB. QNX is only a possible future target and
is not a requirement or validation claim for this deployment.

## Build and check

From the repository root, with Python and Zig 0.14.1 installed:

```powershell
python badge/assets/icons/generate_native_icons.py --check
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
Those tests emulate the RISC-V payload with firmware calls stubbed. They execute
held-state transitions and inspect the LVGL image descriptors selected by the
compiled code, but do not render actual pixels or simulate BLE, LVGL, flash, or
the stock registry.
No full ESP-IDF installation or original firmware source is required to build
this extension. The extension calls the existing firmware's compiled APIs.

Outputs under ignored `build/`:

- `stock-factory.bin`: validated original application image.
- `stock-factory-partition.bin`: exact original factory partition, including
  trailing bytes, for rollback at the same factory offset.
- `overcooked.elf`: native payload with fixed text and constant addresses.
- `overcooked-factory.bin`: factory-only candidate.
- `verification.json`: sizes, hashes, hook bytes, generated-icon hashes, and static verification results.

`../assets/icons/generate_native_icons.py` converts the checked-in PNGs into
`generated_icons.h`, which is committed for review. The build runs the
generator's deterministic `--check` mode and stops if the header is stale.

The original app descriptor stays intact; it still reports the stock version
and ELF hash. Identify the modified image by its SHA-256 and `OC_NATIVE` logs,
not by that unchanged descriptor.

## Production deployment and role selection

The live profile is one native factory image on **all four badges**: one host
and three players. It is the production response to the observed host NimBLE
OOM and player Lua-allocation failure. The existing `master/` and `slave/` Lua
apps remain in the repository and in LittleFS only as the explicit
unmodified-firmware rollback profile; they are not an alternate live profile.

The current native and Lua rollback sources use the OC2 application namespace.
The backup gate below requires preserving the original device before any
LittleFS update. Only after that backup and read-only security inspection may
you push the current `../master/` app to the host and the current `../slave/`
app to all three players. Verify that matching rollback set before the native
factory write. Factory-only deployment leaves LittleFS untouched, and the
laptop intentionally rejects the older OC1 namespace.

Do not mix profiles within a round. Native mode preserves the current OC2
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
   logs `HTN26|GAME|START_GAME|240|3`, broadcasts `OC2|000001|G|S`, counts down
   four minutes, then logs `HTN26|GAME|GAME_END|3` and broadcasts the matching
   end control. Events before start are ignored.

The app continuously draws the player's authoritative local held state, plate
contents, selection, stoves, radio status, and controls. Empty hands have no
stale image and remain labelled `HELD: EMPTY`; raw, chopping, prepared, cooked,
burnt, bun, and plate states select generated artwork. Plate contents remain
listed as the fixed `B/M/L/C` columns next to the plate icon. Pickup, failed or
completed cutting, stove put/take, drop, transfer, submission, game start/end,
and reset all rerender from the same local state used to form events.

The artwork is generated from `../assets/icons/*.png` as ten 28×28 LVGL
RGB565A8 descriptors. The bun deterministically stacks the checked-in top and
bottom assets, while `BURNT_MEAT` consumes the independent named
`../assets/icons/ing_meat_burnt.png` source directly. That source is the
documented temporary cooked-meat placeholder until dedicated burnt artwork is
supplied. The payload uses one reusable image widget rather than ten runtime
image objects or the Lua display test's 196-box grid. Current build metadata
records 26,295 bytes of total payload DROM and a 308-byte permanent app object.
The linker and builder limit live constants to 30,880 bytes (`0x78A0`), ending
before `0x3C270000`. The original 42×42 icon build put its registration log at
`0x3C275EFC` and caused a reproducible MMU-entry boot panic on COM7. The 64 KiB
file-layout growth preserves segment alignment; it is not all usable runtime
mapping space. Emulator coverage now leaves that inaccessible page unmapped.

Radio initialization has a fail-closed NVS preflight and never invokes the
stock erase/recovery branch. The player role then enables NFC; the host role
does not. Program the four NDEF Text tags as `pantry`, `fridge`,
`cutting board`, and `stove`.

- LEFT/RIGHT + pantry: lettuce/bread; LEFT/RIGHT + fridge: meat/cheese.
- DOWN + pantry takes a plate with an empty hand or a prepared held item.
- Prepared pickups go directly onto a held plate; duplicates and raw items are rejected.
- Hold A + cutting board chops meat, lettuce, or cheese; releasing A resets progress.
- LEFT/RIGHT + stove selects stove 1/2, then puts, checks, or takes meat. A
  successful placement broadcast is also the shared cooking-clock edge: the
  sender starts immediately when it queues `ST:<side>:P`, every listening
  player starts on first receipt, and the gateway forwards that same event so
  the server/UI records its authoritative `startedAt` without a badge query.
- Hold B + shake discards; hold A + shake submits the plate. The native B-held
  path uses a 1,400 mg threshold (versus 1,600 mg for unmodified shakes), queues
  the pre-drop OC2 snapshot before clearing the local hand or plate, and requires
  a quiet 0.5-second cooldown before another shake. B + shake with an empty
  inventory is invalid and does not become `READY`. A shake without either
  button broadcasts `READY` for server-side team submission consensus.
- Bump two badges to merge a platable hand item onto the other plate, or swap
  inventories when that merge is invalid or both badges have the same plate state.
  Hold UP on both badges and bump them together to emit the short transfer
  gesture. UP must be held through the bump; pressing UP alone does not transfer.

Invalid station/button combinations show `UNKNOWN BUTTON COMBO` and red LEDs
for one second. Meat cooks for 15 seconds, is done for two, flashes a three-second
warning, then burns. The six LEDs also show cutting and stove progress. Only
the native host acknowledges player actions, so a player makes at most three
identical attempts until the laptop-connected gateway has observed the event. The host
logs each unique event as one `HTN26|RX|...` record and emits periodic gateway
health. The badge tracks immediate controller feedback, while the laptop-hosted local
server/web app remains authoritative for players, orders, scoring, penalties,
and the simultaneous-submit window.
See `RADIO_PROTOCOL.md` for packet format, recovered HAL calls, LED meanings,
and the Windows test peer.

Serial heap measurements include internal 8-bit memory (mask 0x804) and
default memory (mask 0x1000), at entry, before radio, after radio, exit, and
every 250 ticks while idle. The nominal tick interval is 20 ms. The permanent
app object is 308 bytes, excluding allocator, registry, launcher, and LVGL
widget overhead. Generated pixel data is const flash-mapped DROM. LVGL
allocations belong to the app screen and are reclaimed by stock code.

Home uses stock registry exit handling. The app stops the radio; the registry
then cleans the screen and reboots with `focus=overcooked` when radio/NFC was
active. If initialization failed before becoming active, stock behavior may
return directly to the launcher without rebooting. Persistence failure also
retains the stock direct-launch fallback.

## Serial panic triage

The native app only writes serial diagnostics through the pinned `PRINT`
function. It has no serial receive or console-command path; gameplay `OC2`
packets use the radio HAL. Repeated stock-console `Unrecognized command`
messages mean the host is delivering bytes to the badge console; they are not
generated by a DROP payload. On POSIX, a descriptor opened read-only is not
enough to prevent this: the TTY line discipline can echo received badge logs
back to the device. The root laptop server therefore puts real TTY devices in
raw/no-echo/no-hangup mode before reading and fails closed if it cannot do so.
Other terminals, IDEs, bridges, or noisy connections can still create the same
symptom and must remain closed while the server owns the port.

A TLSF `block_next` / `!block_is_last` assertion means heap metadata was already
corrupted. It is not safe to classify that panic as a malformed OC2 record, and
the compiled-callback emulator cannot reproduce the stock allocator, USB
console, BLE allocator, or LVGL heap. Its DROP stress coverage does guard the
308-byte app object and executes the packet, button, motion, retry, render, and
release paths without an out-of-bounds app-object write.

For an affected badge, power it off or disconnect USB and close every IDE,
terminal, serial bridge, and server that has the port open. Do not flash, erase,
or repeatedly boot the crashing image. Preserve the complete first panic,
backtrace, preceding heap lines, candidate SHA-256, and the host process/port
configuration. If one additional capture is necessary, use exactly one
receive-only reader at the correct port settings, never pipe badge output back
to its input, and stop after the first panic. Any later rollback must use the
whole-fleet, factory-only gate below.

## Backup, factory-only flash, and rollback gate

Offline checks do not authorize a flash or establish runtime acceptance. Repeat
this procedure separately for each badge, substituting its port and a unique
backup directory. Never run `erase-flash`, never write a merged/full image, and
never change secure-boot, flash-encryption, security configuration, or eFuses.
Read security state only with the esptool version's `get-security-info` command.
If it differs from the inspected disabled state, stop rather than changing it.

Before any mutation, put the badge in its established bootloader mode and take
a fresh backup while keeping it there:

```powershell
New-Item -ItemType Directory -Force badge-backup
python -m esptool --chip esp32c3 --port COM4 --before no-reset --after no-reset get-security-info
python -m esptool --chip esp32c3 --port COM4 --before no-reset --after no-reset read-flash 0x0 0x400000 badge-backup/full-before.bin
python -m esptool --chip esp32c3 --port COM4 --before no-reset --after no-reset read-flash 0x8000 0x1000 badge-backup/partition-table-before.bin
python -m esptool --chip esp32c3 --port COM4 --before no-reset --after no-reset read-flash 0x10000 0x2A0000 badge-backup/factory-before.bin
```

Verify the partition table and factory hashes against the builder's pinned
inputs before proceeding. Preserve all three files off the badge. Only now may
you leave bootloader mode, boot the unchanged stock firmware, and push the
current OC2 `../master/` app to the host or `../slave/` app to a player. Verify
the installed role and repeat this backup-first sequence for every badge; never
update LittleFS before preserving that badge's original full-device backup.

After all four matching OC2 rollback apps are verified, return each badge to
bootloader mode. Then write **only** the factory application and read it back
before booting:

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

Rollback leaves LittleFS/storage untouched, so the required preinstalled OC2
Lua `master` and `slave` apps remain available. Roll back all four badges
together and select **HTN26
Host** on the gateway plus **HTN26 Player** on each player; do not create a mixed
round.

## Validation boundary and unverified bump behavior

### NFC timeout recovery

`62760` (`0xF528`) is `RC522_ERR_RX_TIMER_TIMEOUT`, defined in the
[reader driver's error table](https://github.com/abobija/esp-idf-rc522/blob/main/include/rc522_types.h).
The pinned image constructs that same return at `0x420A1A5C`; it propagates
through the first page read into `NFC_TEXT`. It is not an undefined return or
proof of BLE interference. The Lua `read_text` wrapper at `0x4205C75C` calls
the same native reader at `0x42010138` with a 256-byte output buffer.

The controller now debounces failed reads and rearms like `nfc_display`.
Receive timeouts additionally stop and clear NFC, leave its field off until
the next 200 ms poll, then re-enable detection before retrying. Recovery is
limited to two restarts; persistent failure asks for removal and another tap.
BLE stays running. Successful text appears on screen even before game start;
gameplay still requires a player role and an active round. Host mode has no NFC.

The emulator checks recovery from injected `62760` with the same UID, no BLE
restart, and bounded persistent failures. This verifies recovery logic, not
the physical cause or resolution of RF timeouts.

The captain reports that the native game binary is working and has been tested
on the badges, with one explicit exception: **physically bumping two badges
together remains unverified**. Do not turn emulator transfer coverage into a
bump-acceptance claim. Share transfer and full Sync likewise retain the real
peer/station limits recorded in the hardware-results documents.

This icon/display revision has offline build and compiled-callback emulator
coverage only. Those tests cover empty, bun, raw, cutting, prepared, cooked,
burnt, plated, drop, transfer, submission, game-end, game-start, and reset icon
selection. They do not render the display or validate visual placement on a
physical badge, so the new screen still needs an on-device visual check. This
narrow display boundary does not rewrite or overstate the captain's reported
baseline hardware result.

The current production integration target is the laptop-hosted local server,
USB serial gateway, and browser UI. QNX may be evaluated later, but no QNX
hardware or runtime validation is required or claimed here.

See `../NATIVE_INVESTIGATION.md` for recovered interfaces and NVS recovery
behavior. The addresses are private ABI details, not a stable SDK.
See `HARDWARE_RESULTS.md` for measured results and remaining physical checks.
`verification.json` reports only the offline build; its `hardware_tested` field
stays false because the builder itself never accesses hardware.
