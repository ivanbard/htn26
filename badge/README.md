# Badge System

The Hacker Badges are the physical player-controller layer for the game.

Before making any changes under `badge/`, read:

`./badge-app-guide.md`

That document is the authoritative source of truth for the Hacker Badge API and hardware capabilities.

Do not invent badge functionality that is not documented there.

In particular, badge applications do not have arbitrary BLE/GATT access or Wi-Fi/HTTP. Communication between game badges uses the restricted `badge.radio` channel documented in the guide. Radio payloads are limited to 1–44 bytes.

The badge API also supports NFC reading and serial logging through `badge.sys.log()`.

---

## Badge Roles

There are two types of badges.

### Player Badge

Each player wears a badge.

Player badges are responsible for:

* reading NFC interactions
* identifying ingredient/station interactions
* sending short game events over `badge.radio`
* showing immediate local feedback
* optionally using LEDs or motion sensors for interactions

Player badges are **not authoritative**.

They report what the player attempted to do.

The QNX game server decides whether the action is valid.

---

### Stationary Gateway Badge

One badge is permanently connected by USB to the main Raspberry Pi.

This badge is both:

1. the radio gateway between the player badges and the QNX server
2. the physical dish-submission station

The gateway badge runs its app continuously while a game is being hosted.

Its primary data path is:

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
main QNX Raspberry Pi
```

The gateway badge should not run authoritative game logic.

It forwards player events to the Pi.

---

## Game Setup Flow

The stationary gateway badge is plugged into the main Raspberry Pi before hosting begins.

Player badges launch the game application and join the game through the badge radio network.

The game should not depend on arbitrary direct Raspberry Pi ↔ player badge Bluetooth communication.

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
main Pi
```

---

## NFC Interaction Model

Physical game objects contain NFC tags.

Examples include:

```text
ING:TOMATO
ING:ONION

STATION:CHOP1
STATION:CHOP2

STATION:POT1
STATION:POT2
```

A player interacts with the game by touching their badge against the relevant NFC tag.

The badge sends that interaction to the server.

Example:

```text
OC1|42|N|ING:TOMATO
```

The server combines this with vision information before modifying authoritative state.

---

## Dish Submission

Dish delivery is intentionally different from ordinary player interactions.

The physical serving plate has an NFC tag attached to it.

To submit an order, the player physically brings the plate to the stationary gateway badge and taps the plate's NFC tag against that badge.

Flow:

```text
completed physical plate
        ↓
tap plate NFC tag
against gateway badge
        ↓
gateway reads tag
        ↓
USB serial
        ↓
main Pi
        ↓
validate dish
        ↓
complete / reject order
```

This makes the delivery point a fixed physical location, similar to the serving counter in Overcooked.

The server should only score the dish if its authoritative state says the plate contains a valid recipe.

The NFC tag itself identifies the plate. It does not need to encode the complete contents of the dish.

---

## Radio Message Protocol

Player badge events use a compact protocol.

Suggested initial format:

```text
OC1|<sequence>|<type>|<value>
```

For example:

```text
OC1|42|N|ING:TOM
OC1|43|N|STN:CHOP1
OC1|44|M|CHOP
```

`OC1` is the protocol version.

The sequence number is monotonically increasing per player badge.

Important actions may be retransmitted, but retransmissions must reuse the same sequence number.

The main Pi deduplicates using:

```text
sender MAC + sequence number
```

Radio is not assumed to be perfectly reliable.

---

## Gateway Serial Format

The stationary badge should forward radio packets to the Pi in an easily searchable format such as:

```text
HTN26|RX|<mac>|<rssi>|<payload>
```

Example:

```text
HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|42|N|ING:TOM
```

The badge runtime may add additional logging text around `badge.sys.log()` output.

The Pi should therefore search each serial line for the `HTN26|` marker instead of assuming the serial line starts with it.

---

## Player Feedback

The badge is a controller, not the main game screen.

Keep information on the player badge concise.

Examples:

```text
TOMATO
PICKED UP
```

```text
CHOPPING
3 / 5
```

```text
POT INTERACTION
SENT
```

The badge may optimistically indicate that an interaction was captured.

Do not claim that the authoritative server accepted an action unless a return communication path has actually been implemented.

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

The primary cooking-state indicators, however, are the physical station lights described by the Pi/game system.

Do not make badge LEDs the only mechanism for knowing whether food is cooked.

---

## Important Constraints

The badge app must remain open while playing.

Badge apps only run while in the foreground, and radio listeners do not continue after returning HOME.

Do not assume:

* Wi-Fi from badge Lua
* HTTP from badge Lua
* arbitrary BLE/GATT
* direct Pi participation in `badge.radio`
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
main Pi sees event
```

After this works, add stations, motion interactions, plate submission, and richer player feedback.

