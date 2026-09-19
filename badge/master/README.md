# HTN26 stationary gateway

This app is the Overcooked IRL master-badge gateway. It enables the restricted
`badge.radio` channel, accepts player packets through `badge.radio.on_recv`,
and forwards valid packets to the USB-connected master Pi with
`badge.sys.log()`:

```text
HTN26|RX|<mac>|<rssi>|<payload>
```

Packets must begin with `OC1|`, contain a non-empty value, and be no more than
44 bytes. The gateway accepts the documented sequence/type/value order and the
legacy player-app type/sequence order. Receive callbacks only validate and
enqueue packets; normal ticks perform bounded serial flushing.

The screen shows radio health, forwarded packets, invalid packets, queue
drops, and radio-ring drops. LEDs show startup failure, recent reception, and
drop/healthy states. HOME exits; exit cleanup unregisters the radio callback,
disables radio, and clears the LEDs.

The host protocol tests in `tests/test_gateway_protocol.py` exercise packet
filtering, framing, size limits, counter saturation, and bounded FIFO behavior
when a Lua runtime is available. Physical badge radio and USB validation still
require hardware and remain pending unless performed separately.
