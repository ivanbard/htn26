# Badge System

The Hacker Badges are the physical player-controller layer for the game.

The pinned native extension in [`native/README.md`](native/README.md) is the
**production/live profile** on the host and all three players. The Lua apps in
`master/` and `slave/` are whole-fleet rollback assets only. Never mix profiles.
The current production host is a laptop connected to the gateway badge over
USB; QNX is only a possible future target, not a current requirement or claim.

Before making any changes under `badge/`, read:

`./badge-app-guide.md`

That document is the authoritative source of truth for the Hacker Badge API and hardware capabilities.

Do not invent badge functionality that is not documented there.

In particular, badge applications do not have arbitrary BLE/GATT access or
Wi-Fi/HTTP. The Lua rollback uses the restricted `badge.radio` channel
documented in the guide. The version-pinned native profile uses only the
recovered stock advertising HAL documented in `native/RADIO_PROTOCOL.md`; it
does not add arbitrary BLE/GATT. Application payloads remain limited to 1–44
bytes.

The badge API also supports NFC reading and serial logging through `badge.sys.log()`.

---

## Badge Roles

There are two types of badges.

### Player Badge

Each player wears a badge.

The fixed-player behavior is documented in [`slave/README.md`](slave/README.md).
The production/live deployment runs that behavior through the pinned native
extension; the self-contained Lua player is rollback-only for stock firmware.
The player path is responsible for:

* reading NFC interactions
* identifying ingredient/station interactions
* sending short game events over `badge.radio`
* showing immediate local feedback
* optionally using LEDs or motion sensors for interactions

Player badges are **not authoritative** for orders or scoring.

They keep authoritative local held/controller state for immediate feedback and
report the resulting intent; the laptop server remains authoritative for
orders, scoring, and the shared game projection.

---

### Stationary Gateway Badge

One badge is connected by USB to the captain's laptop for the current launch.

This badge is the radio gateway between the three player badges and the laptop
server. A QNX/Pi server remains only a possible future target.

V1 submission is a simultaneous-shake action between the three fixed players.
There is no delivery-zone or serving-plate NFC contract in the current product.

The gateway badge runs its app continuously while a game is being hosted.
The supported native/Lua profile selection and no-mixing rule are documented in
[`master/README.md`](master/README.md) and [`native/README.md`](native/README.md).
Both preserve the primary data path:

```text
player badge
    ↓
badge.radio
    ↓
stationary gateway badge
    ↓
badge.sys.log()
    ↓
USB serial
    ↓
captain's laptop server
```

The host badge initiates the physical lifecycle: its START action resets the
three fixed-player badge session, starts its local four-minute countdown, and
emits START_GAME; timeout emits GAME_END and resets that session. The laptop
server applies the authoritative round transitions and owns authoritative
processing of player intent, inventory, orders, scoring, and resulting game
state. Players originate intent; their events are forwarded to the laptop.

---

## Game Setup Flow

The stationary gateway badge is plugged into the captain's laptop before hosting begins.

Each player badge is provisioned as player 1, 2, or 3 before the round. The
host starts the fixed session over radio; there is no radio enrollment or late
join path. The player app's exact install files and controls are owned by
[`slave/README.md`](slave/README.md).

The game should not depend on arbitrary direct laptop/server ↔ player badge Bluetooth communication.

The documented and supported architecture is:

```text
player badges
      ↓
restricted badge radio
      ↓
stationary badge
      ↓
USB serial
      ↓
laptop server
```

---

## NFC Interaction Model

Physical game objects contain NFC tags.

The v1 zones are pantry, fridge, cutting board, and stove.

The current player tag values and button combinations are owned by
[`slave/README.md`](slave/README.md); older fixture tag names are not part of
the current player app contract.

---

## Radio Message Protocol

Player badge events use a compact protocol.

The current player format is:

```text
OC1|<sequence>|<type>|<value>
```

For example:

```text
OC1|000042|E|P2:PU:B
OC1|000043|E|P2:CH:D:D
OC1|000044|E|P2:SUB:BMLC
```

`OC1` is the protocol version.

The sequence number is monotonically increasing per player badge and the
player action is sequence-tagged in the value. The complete current event and
control contract is owned by [`master/README.md`](master/README.md) and
[`slave/README.md`](slave/README.md).

Important actions may be retransmitted, but retransmissions must reuse the same sequence number.
The native host acknowledges these retries but never forwards ACK packets.

The gateway and laptop server may deduplicate using:

```text
sender MAC + sequence number
```

Radio is not assumed to be perfectly reliable.

Native and Lua deployment profiles preserve these application bytes but are not
radio-carrier compatible: Lua's restricted API adds/filters `LUA1`, while the
pinned native extension calls the stock HAL. Deploy or roll back all four
badges together.

---

## Gateway Serial Format

The stationary badge should forward radio packets to the laptop server in an easily searchable format such as:

```text
HTN26|RX|<mac>|<rssi>|<payload>
```

Example:

```text
HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|42|N|ING:TOM
```

The badge runtime may add additional logging text around `badge.sys.log()` output.

The laptop server should therefore search each serial line for the `HTN26|`
marker instead of assuming the serial line starts with it.

---

## Player Feedback

The badge is a controller, not the main game screen. The production native
player nevertheless keeps its screen continuously synchronized with its local
held state: empty, bun, raw/prepared lettuce, raw/prepared cheese, raw/chopped/
cooked/burnt meat, or plate plus fixed `B/M/L/C` contents. It rerenders that
same model after pickup, chopping success/failure, stove put/take, drop,
transfer, submission, game end/start, and reset.

The native image widget uses the deterministic representation generated from
`assets/icons/`; details and flash/RAM limits are owned by `native/README.md`.
Labels remain present so empty hands, plate contents, and action state are not
communicated by artwork alone.

The badge may optimistically indicate that an interaction was captured. Do not
claim that the authoritative laptop server accepted an action unless a return
communication path has actually been implemented.

---

## Badge LEDs

Badge LEDs should provide immediate personal feedback.

Possible meanings:

```text
green    interaction captured
blue     radio/event sent
yellow   currently performing action
red      error
```

The primary cooking-state indicators, however, are the physical station lights
described by the authoritative game system.

Do not make badge LEDs the only mechanism for knowing whether food is cooked.

---

## Important Constraints

The badge app must remain open while playing.

Badge apps only run while in the foreground, and radio listeners do not continue after returning HOME.

Do not assume:

* Wi-Fi from badge Lua
* HTTP from badge Lua
* arbitrary BLE/GATT
* direct laptop/server participation in `badge.radio`
* serial input into the badge Lua app
* reliable packet delivery

Design around the APIs documented in `badge-app-guide.md`.

---

## MVP

The first badge MVP should prove only this:

```text
player scans tomato NFC
        ↓
player badge creates event
        ↓
badge.radio
        ↓
gateway badge receives event
        ↓
gateway logs it over USB
        ↓
laptop server sees event
```

After this works, add the remaining station, motion, and player-feedback interactions.
