# HTN26 stationary gateway / serving-area master

This is the serving-area master badge for the burger level. It stays in the
foreground beside the master Raspberry Pi and has two bounded data paths:

```text
player badges -> restricted badge.radio -> gateway -> badge.sys.log() -> Pi
plate NFC tag -> gateway NFC reader -> badge.sys.log() -> Pi
```

The app always runs in **HOST** mode. Press **START** to emit the room-scan
request:

```text
HTN26|HOST|SCAN|3PI|BURGER
```

The three Pis own camera capture, floor-plan generation, approval, and the
resulting burger placement instructions. The badge has no serial-input or
network API and therefore does not pretend to receive a floor-plan response.

## Gateway packet protocol

Valid player packets begin with `OC1|`, contain a non-empty value, and are at
most 44 bytes. The gateway accepts both forms currently present in the badge
apps and forwards the original payload unchanged:

```text
OC1|<sequence>|<type>|<value>
OC1|<type>|<4-digit sequence>|<value>
```

Every accepted radio packet is logged as:

```text
HTN26|RX|<sender_mac>|<rssi>|<payload>
```

The receive callback only validates and copies into an eight-entry bounded
queue. Normal ticks flush at most four entries, and the screen reports
forwarded packets, invalid packets, queue drops, and radio-ring drops.

## Burger-level tags and plate delivery

Player event values use the compact `OC1` value field. The canonical burger
materials and stationary stations are:

```text
I:CHEESE    I:LETTUCE    I:MEAT    I:BUNS
S:CHOP1     S:CHOP2      S:STOVE1  S:STOVE2
P:01        P:02         P:03
```

The serving-area gateway reads only plate tags `P:01` through `P:03`. A valid
plate NDEF text read is logged as:

```text
HTN26|PLATE|P:01
```

Unknown or unreadable NFC tags increment the bounded NFC-drop counter and are
not sent to the Pi. NFC text is read once per newly seen card with debounce;
the gateway never writes NFC tags.

## Health and limits

The screen shows radio/NFC health, scan state, RX/drop counters, plate count,
and the last radio or plate event. LEDs indicate startup health (red), room
scan request (orange), radio reception (blue), plate delivery (green), drops
(orange), and healthy idle (slow green pulse). HOME exits; exit cleanup
unregisters the radio callback, disables radio and NFC, and clears the LEDs.

`tests/test_gateway_protocol.py` executes the pure Lua helpers when a host Lua
runtime is available, covering filtering, both packet orders, serial framing,
malformed input, burger plate/scan framing, counter saturation, and bounded FIFO
behavior. Physical badge NFC/radio and USB validation require hardware and
remain pending unless performed separately.
