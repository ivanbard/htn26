# HTN26 stationary gateway / serving-area master

Radio is currently blocked by firmware memory pressure. The app uses the shared
transport boundary; upload `badge/transport.lua` and `badge/radio_transport.lua`
beside `main.lua`. See [local testing](../LOCAL_TESTING.md) for runnable NFC and
forwarding checks without hardware radio. The hardware adapter is opt-in.

This is the serving-area master badge for the burger level. It stays in the
foreground beside the master Raspberry Pi and has two bounded data paths:

```text
player badges -> restricted badge.radio -> gateway -> badge.sys.log() -> Pi
```

The app always runs in **HOST** mode. Press **START** to emit the room-scan
request:

```text
HTN26|HOST|SCAN|1PI|PHONE|BURGER
```

The single Pi owns phone-photo upload, local AI floor-plan generation, approval,
and the resulting four-tag placement instructions. The badge has no serial-input
or network API and therefore does not pretend to receive a floor-plan response.

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

## Update 1 station tags and submission

All four NFC tags stay with the player flow and contain these NDEF Text values:

```text
pantry
fridge
cutting board
stove
```

The host does not enable NFC. Player `READY` and `SUBMIT:....` radio actions are
forwarded unchanged; the Pi decides whether the simultaneous-submit window and
active order are valid.

## Health and limits

The screen shows radio health, scan state, RX/drop counters, and the last radio
event. LEDs indicate startup health (red), room scan request (orange), radio
reception (blue), drops (orange), and healthy idle (slow green pulse). HOME
exits; exit cleanup unregisters radio and clears the LEDs.

`tests/test_gateway_protocol.py` executes the production Lua helpers using
`lupa==2.8` (installation in the local-testing guide), covering filtering,
both packet orders, targeted replies, serial framing,
malformed input, burger plate/scan framing, counter saturation, and bounded FIFO
behavior. Physical badge NFC/radio and USB validation require hardware and
remain pending unless performed separately.
