# HTN26 host badge

This is the rollback-only Lua app for the stationary host badge connected to
the production laptop. It initiates the physical round lifecycle and is the
radio gateway; it is not a camera controller or a second source of
authoritative order and score state. QNX is only a possible future target.

## Supported deployment profiles

For the observed host OOM (`free heap 26124`, largest block `15360`, followed
by NimBLE `ESP_ERR_NO_MEM`), the production/live deployment is the pinned native
factory extension in [`../native/README.md`](../native/README.md). Flash that
same candidate to the host and all three players using its backup/factory-only
write gate. Open **Overcooked** on the USB-connected badge and press START to
select host mode; radio starts through the proven clean-reboot native runtime
without enabling host NFC.

`manifest.cfg` plus `main.lua` remain the Lua rollback profile for unmodified
stock firmware. They are intentionally retained and
tested, but the supplied host has not started BLE successfully with that
profile. Do not mix a Lua host with native players or a native host with Lua
players: Lua radio uses a private `LUA1` carrier wrapper while native mode calls
the recovered HAL directly. Profile selection is whole-fleet and rollback is
explicit in the native guide.

Both profiles use OC2. Install this current rollback app before the native
factory-only write so restoring stock firmware cannot expose an older OC1 app
to the OC2-only laptop parser. During native rollout, first preserve the
original full-device backup and complete the read-only security inspection in
the native guide; only then may the IDE push update LittleFS.

The packet bytes, USB serial framing, server ownership, and lifecycle records
below apply to both profiles. Native mode additionally uses private player-to-
host ACK packets, which the host never forwards to the server.

## Host lifecycle

The host app stays in the foreground and shows status plus a `MM:SS` countdown.
Press **START** to:

1. clear the bounded radio queue and reset all three fixed-player session slots;
2. start a 240-second countdown; and
3. log `HTN26|GAME|START_GAME|240|3` and make the same lifecycle hint available
   to nearby player badges through the documented restricted radio channel.

When the countdown reaches zero, the app clears the queue and all three player
slots, stops accepting player events, and logs:

```text
HTN26|GAME|GAME_END|3
```

Pressing START after the end begins a fresh session. Events received while the
host is idle or after the round ends are ignored. The laptop server applies
these lifecycle records and remains authoritative for the game countdown,
player intent, inventory, orders, scoring, and resulting game state.

## Player radio to server serial contract

During an active round, valid sequence-first player payloads are queued and
forwarded unchanged. A forwarded record is one `badge.sys.log()` call with this
stable payload:

```text
HTN26|RX|<sender_mac>|<rssi>|OC2|<sequence>|<type>|<value>
```

For example:

```text
HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC2|0042|N|ING:TOM
```

`sender_mac` is the radio sender identity and `rssi` is the received signal
strength. Payloads are limited to 44 bytes, use `OC2|<sequence>|<type>|<value>`,
and reject control characters and `|` in the value so the server can split fields.
The Lua app accepts `N`, `M`, `B`, `H`, and the fixed-player `E` events emitted
by the current player app. Native mode emits the same compact `E` payload bytes
and forwards them unchanged. The Lua receive callback copies to an 8-entry
FIFO; the native callback uses its documented single fixed slot to avoid the
Lua/system-heap failure.

The server parser should search each physical serial line for `HTN26|` because the
badge runtime may add logging text around the application record. It should
then parse the marker and fields rather than assuming the marker is at column
zero. `HTN26|GW|UP|<forwarded>|<drops>` health lines are also emitted. There is
no serial-input API and no server-to-badge API in this app.

## Install and wire the Lua rollback profile

These instructions are for the unmodified-firmware Lua profile, not the native
OOM path. The app consists only of these two upload files:

```text
badge/master/manifest.cfg
badge/master/main.lua
```

On an IDE page with **Import app**, make one import package using the exact
manifest header and the complete `main.lua` after it (the header delimiter
format is documented in [`../badge-app-guide.md`](../badge-app-guide.md)), then
choose **Import app** and **Replace editor files**. On an older page without
that button, put the `key=value` lines from `manifest.cfg` in the IDE's
`manifest.cfg` editor and all of `main.lua` in its `main.lua` editor. Do not
paste Markdown fences or explanatory text.

Save existing work first. Turn the badge off, connect a USB **data** cable from
the host badge to the captain's laptop USB port, turn it on normally
without holding START, then use **Connect** and choose **USB JTAG/serial debug
unit (Espressif)**. Click **Push** and keep the cable connected until upload
finishes. Open **HTN26 Host** from the launcher and leave it in the foreground.
The IDE's Import changes the browser workspace; Push installs the app. A
successful Push is not a physical gameplay test.

Place the three player badges in range with their player apps open in the
foreground. The host badge's USB serial output is the only server-facing path:

```text
player badges -> restricted badge.radio -> host badge -> USB serial -> laptop server
```

Do not connect the server to a player badge's radio, and do not add a serial
read, network, camera, or server-to-badge dependency. The host-to-player
lifecycle hint is best effort and has no acknowledgement; the server-facing lifecycle record is
always logged locally by the host.

## Host-side checks

From the repository root, install the documented Lua test runtime if needed and
run the focused protocol/static checks:

```sh
python -m pip install --target .tools/python lupa==2.8
python -m unittest discover -s badge/master/tests -p 'test_*.py' -v
```

These checks cover payload validation, sender/RSSI framing, lifecycle records,
44-byte bounds, the bounded FIFO, and the three-player reset shape. Native
build/emulator checks are separate in `../native/README.md`. Neither suite
proves USB serial, radio range, timer accuracy, LED appearance, or badge
firmware behavior. Offline suites do not prove physical behavior. The captain
reports the native binary working except that physical two-badge bumping
remains unverified; see the native guide for the exact boundary.
