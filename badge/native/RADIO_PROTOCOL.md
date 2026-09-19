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

Gameplay uses variable-length action events and one 17-byte acknowledgement:

```text
OC1|01234567|N|PICK:MEAT
OC1|01234567|A|OK
```

The eight decimal digits are a per-boot randomized, monotonically increasing
sequence. The acknowledgement echoes it. The `OC1` prefix isolates game traffic
from Share and other stock advertisements.

A sends the next valid action. Accepted values are `PICK:MEAT`, `PICK:BREAD`,
`PICK:LETTUCE`, `PICK:CHEESE`, `CUT`, `STOVE`, `PLATE`, `SERVE`, and `DISCARD`.
The badge waits 150 ticks (nominally three seconds) and makes
at most three attempts using the exact same sequence and packet. Only a matching
ACK completes the request. An idle peer advertises the ACK for 100 ticks
(nominally two seconds). Repeated events are acknowledged again after that
window but produce only one gateway serial frame:

```text
HTN26|RX|<sender_mac>|<rssi>|OC1|01234567|N|PICK:MEAT
```

For this play-test build, an ACK commits the sender's local state. The peer only
acknowledges and logs the action; it does not mirror that state. The future Pi
will consume the same serial frames and become authoritative. NFC is not added yet.
Overcooked uses 30 ms minimum/maximum advertising intervals, matching Share's
existing send setup. Scanning timing stays at the stock HAL default. Faster
advertising costs radio airtime while sending; advertisements stop on timeout,
matched reply, or expiry of the reply window.

The receive callback validates and copies into one fixed slot. It never calls
LVGL or transmits. The app tick consumes the slot and handles display/transmit.
Aligned 32-bit loads/stores plus RISC-V acquire/release fences publish the slot;
no unsupported RV32 atomic extension or libatomic is needed. A full slot drops
new reports and increments a diagnostic counter. The app object is 244 bytes.

LED 0: green ready. LED 1: blue send. LED 2: yellow receive. LED 5: red error.
Pulses last 25 ticks. Inputs account for the stock HAL's brightness curve.
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

The receiver filters that peer and the OC1 prefix, bounds its receive queue,
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
