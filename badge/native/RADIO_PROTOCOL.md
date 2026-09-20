# Native controller transport

This documents the private ABI recovered from stock `v0.1.2-392-gd3089c4`.
These addresses must not be used with other firmware images. The builder pins
the original image and preserves its loaded code except the registration hook.

## Reused stock APIs

| Address | Recovered behavior |
| --- | --- |
| `0x42010C54` | Set application advertising payload `(data, length)`, returns ESP error |
| `0x42010CC2` | Pause advertisements |
| `0x42010D36` | Resume advertisements |
| `0x42011330` | Move a 16-byte `std::function` receive handler into the HAL |
| `0x42010FC2` | Copy the HAL's static-random advertising address |
| `0x42010DBE` | Set advertising minimum/maximum interval in milliseconds |
| `0x420110F4` | NimBLE extended-report parser and callback dispatch |
| `0x42010712` | Construct manufacturer-data AD structure and install it |
| `0x4205E52A` | Trivial pointer-capture manager used by stock Lua radio |
| `0x40389792` | Existing `esp_random`, identified by clock-ratio/wait/XOR implementation |
| `0x4200F4CA` | Set LED index 0–5, RGB bytes |
| `0x4200F58A` | Refresh LED strip |
| `0x4200F54A` | Clear LED strip |

The HAL accepts 1–225 application bytes. It wraps them as an advertising data
structure: length `payload_length + 3`, type `0xFF`, company ID `0xFFFF` in
little endian, then application bytes. It uses extended advertisements on
1M PHY. Calling the setter changes repeated advertisement content; it is not
a reliable datagram send or a connection.

Receive handles NimBLE event 0x13, accepts complete reports (data status zero),
bounds-checks AD structures, and selects manufacturer ID 0xFFFF. The callback
receives source address bytes, signed RSSI, application bytes, and length.
The address bytes are reversed when displayed as the conventional Bluetooth MAC.

The function object is `[capture pointer, zero, manager, invoker]`. Its invoker
receives pointers to the argument values, as confirmed by stock call sites.
The HAL copies the handler under a mutex before invoking it from the NimBLE
task. The compiled tests execute the actual stock move/copy/destructor and
AD parser with the new invoker, rather than merely imitating that ABI.

## Controller application protocol

Native mode preserves the current player payload and host-control shapes:

```text
OC2|012345|E|P2:PU:R
OC2|000001|G|S
OC2|012345|A|OK
```

The six decimal event digits are randomized at each native player-app boot and
increase monotonically during that boot. Player numbers are explicitly selected
as 1, 2, or 3 before radio starts. Host control sequences begin at one. The
private 15-byte ACK echoes the event sequence; it is native reliability
machinery and is never forwarded to the laptop server.

Application action values match `../slave/main.lua`: `PU:B|R|Q|K`,
`PL:NEW` or `PL:<BMLC>`, `CH:S|F` and `CH:D:D|L|C`, `ST:L|R:P|T|X`,
`ST:L|R:C:<phase>`, `DROP:<snapshot>`, `X:<snapshot>`, `READY`, and
`SUB:<BMLC>`. A snapshot is `P` plus four fixed plate columns, `H` plus one
item code, or `E----`; `-` means absent. Hand code `D` is chopped meat and `M`
is cooked meat, so transfer snapshots preserve the native held state without
context-dependent decoding. Payload validation remains bounded to the
documented 44-byte application limit.

`ST:<side>:P` is both the placement event and the distributed cooking-clock
edge. The sender starts its local 15-second timer when the event is queued;
player peers start their copies on first receipt; the laptop records the
authoritative wall-clock `startedAt` when the gateway serial record arrives and
projects the same timeline to the frontend. No badge polls the host for stove
state. `X:<snapshot>` remains room-wide transport, but a player consumes it only
after detecting its own tap in the same half-second window, so a third listening
badge does not participate.

OC2 is the only active sequence-first namespace. It introduces the distinct
chopped/cooked meat encoding and is intentionally incompatible with OC1. The
application bytes match the current Lua rollback contract, but the physical
profiles are not interoperable. `badge.radio` adds and filters a firmware-private `LUA1`
carrier prefix. The native app calls the recovered HAL directly and therefore
advertises `OC2` as the manufacturer payload. Deploy native mode to the host and
all three players together, or roll all four back to Lua together.

A player waits 150 ticks (nominally three seconds) and makes at most three
attempts using the exact same sequence and packet. Only the badge in **host
role** sends ACKs. This prevents another player from stopping a retry before
the single host gateway has observed and logged the event. An ACK is advertised
for 100 ticks (nominally two seconds). A later duplicate is acknowledged again
but produces only one gateway serial frame:

```text
HTN26|RX|<sender_mac>|<rssi>|OC2|012345|E|P2:PU:R
```

The host emits `HTN26|GW|UP|<forwarded>|<drops>` every 250 ticks and emits
`HTN26|GW|DOWN|0|0` if its NVS preflight or radio initialization fails. START
emits `HTN26|GAME|START_GAME|240|3` and `OC2|000001|G|S`; timeout emits
`HTN26|GAME|GAME_END|3` and `OC2|000002|G|E`. Events are ignored before start.
The laptop server remains authoritative for the game countdown, inventory,
orders, score, and submission results. QNX is only a possible future target,
not a current deployment requirement or validation claim.

Overcooked uses 30 ms minimum/maximum advertising intervals, matching Share's
existing send setup. Scanning timing stays at the stock HAL default. The receive
callback validates and copies into one fixed slot and never calls LVGL or
transmits. The app tick consumes that slot. Aligned 32-bit accesses plus RISC-V
fences publish it without an atomic runtime. A full slot increments the drop
counter. The app object is 308 bytes with the held-item image handles;
generated pixel data remains const flash-mapped DROM.

LED 0: green ready. LED 1: blue send. LED 2: yellow receive. LED 5: red error.
Normal pulses last 25 ticks; invalid-combination red lasts 50 ticks. Inputs
account for the stock HAL's brightness curve.
Exit disables receive acceptance, invokes stock radio
stop, clears LEDs, and follows the existing focused-launcher reboot lifecycle.

## Windows peer

Install the small WinRT projections locally:

```powershell
python -m pip install --target .tools/ble winrt-Windows.Devices.Bluetooth==3.2.1 winrt-Windows.Devices.Bluetooth.Advertisement==3.2.1 winrt-Windows.Storage.Streams==3.2.1 winrt-Windows.Foundation==3.2.1 winrt-Windows.Foundation.Collections==3.2.1
python badge/native/ble_receiver.py --self-test
```

Use `OC_NATIVE|advertising_mac=...` from the boot log. The HAL derives its own
static-random address, which differs from both the USB and controller MACs.
For this badge the derived address is `d0:86:29:c1:3d:e8`:

```powershell
# Answer badge button presses for one minute.
python badge/native/ble_receiver.py --peer d0:86:29:c1:3d:e8 --seconds 60
# Initiate repeated gameplay events and require matching ACKs.
python badge/native/ble_receiver.py --peer d0:86:29:c1:3d:e8 --count 20
# Capture badge transmissions when Windows cannot advertise.
python badge/native/ble_receiver.py --peer d0:86:29:c1:3d:e8 --listen-only --seconds 60
```

The receiver filters that peer and the OC2 prefix, bounds its receive queue,
and stops scanning/advertising on exit. It does not open COM4. Windows controls
advertisement scheduling, so latency must be measured rather than assumed.

This computer's MediaTek adapter reports central, peripheral, and extended
advertising support (maximum advertisement data 312 bytes). Scanning works.
Publishing currently aborts with `BluetoothError.OTHER_ERROR`, including a
standalone run of Microsoft's minimal Hello World manufacturer-data example.
Both extended and legacy publishing failed. Capability flags alone therefore
do not establish a working two-way receiver. Bluetooth was switched on for
these tests. No driver was installed or replaced.

References: [Microsoft BLE advertisements](https://learn.microsoft.com/en-us/windows/apps/develop/devices-sensors/ble-beacon),
[extended publishing](https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.advertisement.bluetoothleadvertisementpublisher.useextendedadvertisement),
[extended scanning](https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.advertisement.bluetoothleadvertisementwatcher.allowextendedadvertisements),
[IDF random implementation](https://github.com/espressif/esp-idf/blob/v5.5.3/components/esp_hw_support/hw_random.c).
