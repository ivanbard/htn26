# Milestone 2 validation

Date: 2026-09-19. Device: the same ESP32-C3 badge on COM4.
Milestone 1 is archived separately; see `HARDWARE_RESULTS.md`.

## Implementation

- A sends PING with a fresh random challenge. Matching PONG completes it.
- Incoming PING gets PONG while the app is idle.
- The UI shows radio status, last received packet, peer MAC, and counters.
- LEDs indicate ready, transmit, receive, and error.
- One bounded receive slot and a 128-byte app object avoid retained packet queues.
- Existing HAL, stock reboot lifecycle, launcher, and unrelated apps are reused.
- NFC and gameplay remain excluded.

The stock button event occupies two bytes but its dispatcher loads four bytes
from the stack. The native callback masks the unspecified upper 16 bits.
This was found in the first hardware button check and added to compiled tests.

## Build and offline checks

Current candidate: 2,720,432 bytes; factory space remaining: 32,080 bytes.
Payload code: 3,058 bytes; constants: 1,036 bytes.
SHA-256: `19933b68ee02f9b06928c2c4a1645f66435ff878c4ec9662d14cd2afe7a49ac0`.
The compiled app object grew by 112 bytes from Milestone 1.
The current mapping also limits added executable code to 14,560 bytes total;
11,502 bytes of that code budget remain. Free factory bytes alone are not the
complete limit for later native features. The builder enforces both limits.

Passing checks:

- Original image reconstruction and both supplied backup hashes.
- Factory bounds, MMU alignment, expected hook bytes, protected loaded segments.
- Independent esptool image checksum/digest validation.
- Actual compiled RISC-V callbacks, NVS preflight errors, radio/send errors,
  exact packet length/prefix/token validation, matching replies, duplicate
  advertisements, unmatched-response timeout, and post-exit callback rejection.
- Actual stock AD parser and `std::function` capture copy/move/destruction with
  the new receive handler, executed under Unicorn with hardware calls stubbed.
- Windows packet encoder/decoder validation.

The compiler initially rejected atomic builtins because this target lacks the
RISC-V A extension. Explicit aligned accesses with memory fences replaced them;
no new atomic runtime or radio stack was linked.

## Computer receiver limitation

The MediaTek adapter reports BLE central/peripheral and extended advertising
support. Scanning succeeds. Publishing aborts with `BluetoothError.OTHER_ERROR`
for both extended and legacy advertising, even with Microsoft's standalone
minimal Hello World example and no concurrent watcher. This is an unresolved
Windows/adapter publishing failure, not proof of badge receive failure.

Use `ble_receiver.py --listen-only` for one-way reception on this machine.
The normal responder and `--count` initiator remain available for a working
Windows publisher. The implementation does not silently substitute serial
or loopback traffic for radio.

Full PING/PONG acceptance still requires repeated matching over-the-air replies
from a working receiver or the second badge. Neither emulator tests nor
one-way reception satisfy that gate. Stock Share transfer and full Sync station
checks also remain pending until peer hardware is available.

## First over-the-air run

The badge's static-random advertising address is `d0:86:29:c1:3d:e8`, confirmed
by the native HAL and PC reception. The controller MAC printed by NimBLE init
is different and must not be used as the receiver filter.

Ten button-triggered PINGs were sent successfully. Windows received nine unique
matching payloads. All ten badge requests timed out as expected with a receive-
only PC. There were no crashes or unexpected resets. Idle system heap varied
between 20,600 and 20,636 bytes; largest free block stayed at 8,704 bytes.
That is evidence of actual BLE transmission and short-run memory stability,
not reliable-delivery acceptance.

Entry heap: 75,384 bytes, largest block 65,536. Immediately after radio startup:
22,296 bytes, largest block 14,336. These values include the new callback and
UI costs; the console finishes allocating shortly afterward.

The user confirmed the waiting/timeout screen but could not see the initial
LEDs. The stock HAL applies a quadratic curve plus output scaling: input 24
maps to one output count. Inputs were increased to 128–192 and pulses to 25
ticks; no stock brightness setting or HAL was changed.
The user subsequently confirmed the green ready LED and send/timeout flashes
were visible. Receive/error channels were also separated so timeout does not
light the receive indicator.

A second run at the default advertising interval received four of five PINGs.
These incomplete runs motivated trying Share's existing 30 ms advertising
interval rather than adding a different transport or retry stack.

Evidence: ignored `build/m2b-boot.txt`, `build/m2b-ping-serial.txt`,
`build/m2b-pc-listen.txt`, and `build/m2b-radio-summary.json`.

## Final timing run and preservation

With Share's 30 ms advertising interval, Windows received all ten distinct
PINGs in the next run. Every request correctly timed out on the badge because
the PC was deliberately receive-only. No PONG was received or claimed.
Idle free heap ranged from 20,588 to 20,624 bytes; largest block stayed at
8,704 bytes. No panic or unexpected reboot occurred during the run.
Ten successes are a short test, not a packet-loss guarantee or round-trip proof.

Final-build entry and pre-radio heap were 75,384 bytes (largest 65,536).
Immediately after radio initialization they were 24,080 bytes (largest 15,872),
before the console finished startup. Initial idle was 20,784 bytes. Startup
scheduling changes these intermediate samples; steady idle is the useful
comparison for retained memory.

Before each factory write, a fresh full read was checked against the preceding
known image and the original partition table. After each write, full readback
before boot verified exact candidate bytes and unchanged bytes everywhere
outside factory. Final sector-rounded write end: `0x2A9000`, safely before
storage at `0x2B0000`. NVS, PHY, bootloader, partition table, and LittleFS were
not supplied to any write command. No eFuses were changed.

The write command remained:

```powershell
python -m esptool --chip esp32c3 --port COM4 --baud 460800 --before no-reset --after no-reset write-flash 0x10000 badge/native/build/overcooked-factory.bin
```

Evidence: `build/m2d-boot.txt`, `build/m2d-ping-serial.txt`,
`build/m2d-pc-listen.txt`, `build/m2d-radio-summary.json`,
`build/m2d-before.bin`, `build/m2d-after.bin`, and `build/m2d-readback.json`.
The Windows publishing failure is retained in `build/m2-publisher-failure.txt`.

## Final regression smoke checks

On the final image, Overcooked exited through the focused-launcher reboot.
Share initialized BLE and displayed its Receive/WAITING screen, then exited
cleanly. Sync initialized BLE and searched for a station, then exited cleanly.
Existing Lua Bullet Dodge launched through the normal launcher, accepted A
and Right input, and returned to the launcher. Finally, selecting native
Overcooked from the launcher clean-rebooted and initialized BLE successfully.
These smoke checks did not exercise actual Share transfer or station Sync.

Evidence: `build/m2d-regressions.txt`. The badge was left on Radio ready,
COM4 was closed, and the PC watcher/publisher processes finished. Windows
Bluetooth remains on for subsequent receiver use.

Milestone 2 status: implemented, with hardware-proven badge-to-PC transmission.
Repeated matching over-the-air PING/PONG is still pending a working advertiser
or second badge. Do not advance to NFC/gameplay on the basis of this result alone.
