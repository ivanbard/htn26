# FILE: `/README.md`

# HTN26 — Overcooked IRL

## Goal

Build a real-world multiplayer cooking game inspired by Overcooked.

Players wear Hacker Badges. Physical NFC tags represent ingredient sources, workstations, pots, serving stations, etc. Three Raspberry Pis running QNX use cameras and on-device AI to track player positions. A central QNX Raspberry Pi maintains the authoritative game state.

The system must run locally. Do not depend on cloud services.

This project is also being built for the QNX prize track:

* Project must run on QNX OS.
* Project must use at least one qualifying open-source AI module available from `https://oss.qnx.com/`.
* AI inference must run on embedded hardware or a QNX VM, not in the cloud.
* The design should demonstrate real-time behaviour, reliability, and graceful handling of failures.

The exact qualifying QNX AI module must be verified against `oss.qnx.com` and documented before submission. Do not silently substitute an unrelated AI package and assume it satisfies the sponsor requirement.

---

## System architecture

```text
       PLAYER BADGES
 ┌────────┬────────┬────────┬────────┐
 │ Badge1 │ Badge2 │ Badge3 │ Badge4 │
 └───┬────┴───┬────┴───┬────┴───┬────┘
     │        restricted badge.radio
     └──────────────┬─────────────────┘
                    ▼
          ┌─────────────────────┐
          │ MASTER BADGE        │
          │ Radio gateway       │
          │ Permanently wired   │
          │ to master Pi        │
          └──────────┬──────────┘
                     │ USB serial
                     ▼
       ┌──────────────────────────────┐
       │ PI MASTER — QNX             │
       │                              │
       │ Authoritative game state     │
       │ Badge event ingestion        │
       │ Camera #1 + AI               │
       │ Position fusion              │
       │ Orders / timers / scoring    │
       │ Health monitoring            │
       │ UI server                    │
       └──────────────┬───────────────┘
                      │ local network
              ┌───────┴────────┐
              ▼                ▼
       ┌─────────────┐   ┌─────────────┐
       │ PI WORKER 2 │   │ PI WORKER 3 │
       │ QNX         │   │ QNX         │
       │ Camera #2   │   │ Camera #3   │
       │ Local AI    │   │ Local AI    │
       └─────────────┘   └─────────────┘
```

There are two completely separate uses of the word "master":

* **Master badge** = USB-connected radio gateway.
* **Master Pi** = authoritative game controller.

Player badges are referred to as **slave badges** in this repository. Camera Pis are referred to as **slave/worker Pis**.

---

## Source-of-truth hierarchy

Agents must follow these sources in this order:

1. `badge/badge-app-guide.md` is the authoritative source for Hacker Badge capabilities and APIs.
2. This README defines overall architecture and system ownership.
3. Component READMEs define individual responsibilities and interfaces.
4. Existing tests and code define implementation details.

If assumptions conflict with `badge/badge-app-guide.md`, the guide wins.

Do not invent badge APIs.

In particular:

* Do not assume custom badge apps have Wi-Fi.
* Do not assume HTTP is available from badge Lua.
* Do not assume arbitrary BLE/GATT access.
* Do not assume USB serial input into a running badge Lua application exists.
* Do not assume a Raspberry Pi can directly participate in `badge.radio`.
* The supported design uses another badge as the radio gateway.

---

## Core design principle

Different sensors answer different questions.

### Badge / NFC

Answers:

> What action did the player intend to perform?

Examples:

* picked up tomato
* interacted with chopping board
* interacted with pot
* delivered a plate

### Camera / AI

Answers:

> Where is the player physically located?

Examples:

* Player 2 is at chopping station 1
* Player 4 is near stove 2
* Player 1 has left a station

### Master game engine

Answers:

> Is the requested action legal, and how should game state change?

Example:

```text
Badge:
Player 2 scanned CHOP1

Vision:
Player 2 is physically inside CHOP1 zone

Game state:
Player 2 is holding RAW_TOMATO

Result:
Start chopping RAW_TOMATO
```

The camera system is not expected to visually recognize every ingredient.

---

## Authoritative state

Only the master Pi owns authoritative game state.

This includes:

* player registration
* badge MAC → player mapping
* player inventory
* player physical position
* player current station
* station contents
* processing timers
* recipes
* active orders
* scores
* game clock
* health of camera workers

Slave badges may show optimistic/local feedback, but they must not be treated as authoritative.

Worker Pis never modify game state directly.

The UI never owns game state.

---

## Badge message protocol

All custom game radio messages use this format:

```text
OC1|<sequence>|<type>|<value>
```

Examples:

```text
OC1|0042|N|ING:TOM
OC1|0043|N|STN:CHOP1
OC1|0044|M|CHOP
OC1|0045|B|A
```

Fields:

* `OC1` — protocol/version prefix
* `sequence` — monotonically increasing per-badge sequence number
* `type`

  * `N` = NFC event
  * `M` = motion event
  * `B` = button/game-control event
  * `H` = heartbeat/status
* `value` — compact payload

Keep the complete radio payload at or below the limit defined by `badge/badge-app-guide.md`.

Player identity does not need to be placed in every radio packet. The gateway receives the sender MAC and the master Pi maps that MAC to a player.

Radio delivery is not assumed reliable.

Player badges should retransmit important events a small bounded number of times. The master Pi must deduplicate using:

```text
(sender MAC, sequence number)
```

Never apply the same game event twice.

---

## Gateway serial protocol

The master badge forwards radio messages to the master Pi using serial logging.

The logical forwarded message is:

```text
HTN26|RX|<sender_mac>|<rssi>|<badge_payload>
```

Example:

```text
HTN26|RX|AA:BB:CC:DD:EE:FF|-53|OC1|0042|N|ING:TOM
```

The Hacker Badge runtime may add its own logging prefix/tag around output. The Pi parser should search for and parse the `HTN26|` portion rather than assuming the physical serial line starts exactly with `HTN26`.

The initial architecture is intentionally one-way:

```text
player badge
    ↓
badge radio
    ↓
gateway badge
    ↓
USB serial
    ↓
master Pi
```

Do not make core gameplay depend on master Pi → player badge communication.

---

## NFC representation

Prefer NDEF text tags when convenient.

Suggested namespace:

```text
ING:TOM
ING:ONION
ING:LETTUCE

STN:CHOP1
STN:CHOP2
STN:POT1
STN:POT2
STN:PLATE
STN:DELIVERY
```

The badge application is a reader. Tag provisioning/writing occurs externally.

UID-based mappings may also be supported by the server, but avoid hard-coding physical UIDs throughout game logic.

---

## Vision architecture

Each Raspberry Pi processes its own camera locally.

Do not stream all camera video to the master Pi for inference.

Each worker performs approximately:

```text
camera frame
    ↓
QNX camera pipeline
    ↓
qualifying on-device AI module
    ↓
person detection
    ↓
local tracking
    ↓
player identity association
    ↓
camera calibration / homography
    ↓
world-space player positions
    ↓
master Pi
```

Target approximately 5–10 useful tracking updates per second. Smooth, stable tracking is more important than high FPS.

Do not use facial recognition.

Prefer a deterministic visible player identifier such as an AprilTag/ArUco-style marker or other robust marker attached to the badge/lanyard. AI should detect/track people; deterministic identification may be layered on top.

All camera nodes must report positions in one shared world coordinate system.

---

## Reliability model

This is a game, not a safety-critical medical or industrial controller. Do not claim otherwise.

However, design it using reliability principles relevant to embedded systems:

* local inference
* bounded processing
* no cloud dependency
* heartbeats
* stale-data detection
* idempotent events
* redundant camera coverage
* explicit degraded state
* process health monitoring
* deterministic authority over game state

If one camera worker fails:

```text
CAM 1: HEALTHY
CAM 2: FAILED
CAM 3: HEALTHY

Tracking coverage: DEGRADED
Game engine: RUNNING
```

The master should continue running where sufficient observations remain.

A stale or unknown position should cause location-dependent actions to be rejected or deferred rather than guessed.

---

## MVP gameplay

Start with exactly one complete recipe before expanding.

Suggested MVP:

```text
TOMATO SOUP

1. scan tomato source
2. go to chopping board
3. scan chopping board
4. perform chopping action
5. scan pot
6. wait for cooking timer
7. scan plate
8. scan delivery
9. receive score
```

First target:

* 2 player badges
* 1 gateway badge
* 1 master Pi
* 1 camera
* one recipe
* one ingredient
* one chopping station
* one pot
* one delivery station

Only add all three cameras and four players after this loop works end-to-end.

---

## Recommended implementation order

1. Prove player badge → master badge radio.
2. Prove master badge → Pi USB serial.
3. Send one NFC event end-to-end into a simple QNX process.
4. Build authoritative game-state engine with no cameras.
5. Add one QNX camera + AI process.
6. Convert detections into world coordinates.
7. Fuse location validation with badge events.
8. Add Pi worker protocol.
9. Add camera 2 and camera 3.
10. Add UI.
11. Add failure injection and degraded-mode demo.
12. Add more recipes/content.

Do not start by implementing three-camera fusion.

---

## Repository layout

```text
badge/
  badge-app-guide.md
  master/
    README.md
  slave/
    README.md

pi/
  README.md
  master/
    README.md
  slave/
    README.md

ui/
  README.md
```

Expected later:

```text
badge/master/
  main.lua
  manifest.cfg

badge/slave/
  main.lua
  manifest.cfg

pi/common/
pi/master/src/
pi/slave/src/

ui/
  src/
```

Keep shared protocols centralized when implementation begins. Do not independently redefine packet formats in several components.

---

## Definition of success

The MVP is successful when:

1. A player taps an NFC ingredient tag.
2. Their badge sends an event over badge radio.
3. The wired gateway badge receives it.
4. The gateway writes it to USB serial.
5. The QNX master Pi receives and deduplicates it.
6. The camera system reports the player's position.
7. The master validates the physical action against game state.
8. The authoritative state changes exactly once.
9. The UI reflects the new state.
10. Killing one camera worker produces a visible degraded state without crashing the game.

# FILE: `/badge/master/README.md`

# Master Badge — Radio/USB Gateway

## Purpose

This badge is not a player.

It is a dedicated embedded gateway permanently connected by USB to the master QNX Raspberry Pi.

Its only critical responsibility is:

```text
player badges
    ↓ badge.radio
MASTER BADGE
    ↓ badge.sys.log / USB serial
master Pi
```

Read `../badge-app-guide.md` before modifying this component.

That document is the source of truth for every badge API used here.

Do not use undocumented functionality.

---

## Responsibilities

The master badge must:

1. start the badge radio
2. register a short receive callback
3. receive packets from player badges
4. obtain sender MAC and RSSI
5. validate basic packet size/prefix
6. forward valid packets to serial
7. count received/dropped packets
8. show gateway health on its screen
9. remain in the foreground for the entire game
10. disable/clean up radio and LEDs on exit

It does **not** own game logic.

It does **not** decide whether actions are valid.

It does **not** track player inventory.

---

## Serial output

Forward received messages in logical form:

```text
HTN26|RX|<mac>|<rssi>|<payload>
```

Example:

```text
HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|0023|N|ING:TOM
```

Use `badge.sys.log()`.

The Pi should search incoming serial output for `HTN26|` because firmware logging may add an app/console prefix.

Also emit periodic gateway status, for example:

```text
HTN26|GW|UP|1842|0
```

where the final fields may represent packet count and dropped-frame count.

Status format may evolve, but radio-forwarding format should remain stable.

---

## Radio rules

Player messages must begin:

```text
OC1|
```

Reject unrelated Lua radio messages.

Keep receive callbacks short.

Do not:

* perform game-state calculations
* perform expensive UI work in the receive callback
* write files for every packet
* block or sleep
* assume queued radio packets were reliably delivered

If serial logging becomes too slow, queue a small bounded number of events in memory and flush them from normal ticks.

Never allow an unbounded queue.

---

## UI

Keep the gateway UI simple.

Suggested screen:

```text
OVERCOOKED GATEWAY

Radio: ONLINE
Packets: 1842
Dropped: 0

Last:
AA:BB:... ING:TOM

USB -> MASTER PI
```

LED behaviour may indicate:

* green slow pulse = healthy
* blue pulse = packet received
* red = radio startup failure
* orange/red = dropped radio frames observed

The UI is diagnostic only.

---

## Important constraints

Do not assume arbitrary Bluetooth/GATT.

Do not assume Wi-Fi or HTTP.

Do not assume serial input is available to this Lua app.

The architecture only relies on serial output.

Do not build required gameplay around Pi → master badge → player badge commands unless a separately verified supported mechanism is added later.

---

## Testing

At minimum test:

* radio enable succeeds
* one slave badge packet reaches serial
* two slave badges interleave correctly
* duplicate payloads are forwarded unchanged
* malformed/non-`OC1` traffic is ignored
* high-rate input does not crash UI
* `badge.radio.dropped()` is surfaced
* exiting clears LEDs and disables radio
* reopening creates a clean gateway session

# FILE: `/badge/slave/README.md`

# Player Badge

## Purpose

This is the application worn by each player.

It turns the physical badge into a game controller using:

* NFC
* physical buttons
* accelerometer/motion when useful
* badge screen
* LEDs
* restricted badge radio

Read `../badge-app-guide.md` before changing this component.

That file is the source of truth for supported APIs.

---

## Responsibilities

The player badge should:

1. identify itself through its radio MAC / provisioned badge identity
2. enable NFC
3. enable badge radio
4. detect new NFC interactions
5. convert those interactions into compact game events
6. send events to the gateway badge
7. use sequence numbers
8. retransmit important events a small bounded number of times
9. provide immediate local visual feedback
10. optionally detect specific motion actions such as chopping

The player badge does **not** own authoritative game state.

The master Pi decides whether an action actually succeeds.

---

## Radio protocol

Send:

```text
OC1|<sequence>|<type>|<value>
```

Examples:

```text
OC1|0001|N|ING:TOM
OC1|0002|N|STN:CHOP1
OC1|0003|M|CHOP
OC1|0004|N|STN:POT1
```

Sequence numbers are per badge.

They should advance for each new logical user event.

When retransmitting the same event, reuse the same sequence number.

Example:

```text
OC1|0042|N|ING:TOM
OC1|0042|N|ING:TOM
OC1|0042|N|ING:TOM
```

The master Pi deduplicates those into one logical action.

Do not generate a new sequence number for each retry.

---

## NFC behaviour

Preferred semantic tag values:

```text
ING:TOM
ING:ONION
ING:LETTUCE

STN:CHOP1
STN:CHOP2
STN:POT1
STN:PLATE
STN:DELIVERY
```

When a new tag is detected:

1. read it once
2. debounce repeated reads of the same physical tag
3. create one logical game event
4. display immediate feedback
5. queue a small bounded number of radio transmissions

Do not repeatedly perform expensive NFC text reads every tick.

---

## Local state vs authoritative state

The badge may display:

```text
TOMATO PICKED UP
GO TO CHOPPING
```

after the player scans a tomato.

That is immediate local feedback, not proof that the server accepted the action.

Avoid UI wording such as:

```text
SERVER CONFIRMED
ACTION ACCEPTED
```

because the current architecture has no guaranteed return communication path from the master Pi.

Prefer:

```text
TOMATO SCANNED
EVENT SENT
```

The game dashboard is the authoritative visible state.

---

## Motion

Motion is optional for the first MVP.

A future chopping interaction may be:

```text
scan STN:CHOP1
    ↓
badge enters local chopping-input mode
    ↓
detect bounded repeated chopping movement
    ↓
send:
OC1|0123|M|CHOP
```

Keep gesture detection intentionally simple and robust.

Do not build a complicated ML model on the badge.

---

## LED language

Suggested:

* green pulse = NFC interaction captured
* blue chase = event being transmitted
* yellow = processing/action mode
* red pulse = local error
* player-specific idle colour = optional

Use LEDs for feedback, not as the only indication of game state.

---

## Foreground requirement

The app must remain open while playing.

Do not assume radio, timers, or game logic continue after HOME exits the app.

The game should make this obvious to players.

---

## Error handling

Handle:

* NFC unavailable
* radio unavailable
* malformed tags
* payload too large
* unexpected sensor failures
* repeated scans
* sequence rollover

Do not crash because one sensor is unavailable.

Display a concise error state and allow retry where possible.

---

## Definition of success

A slave badge is working when:

1. player launches the app
2. NFC and radio initialize
3. player taps `ING:TOM`
4. screen/LED gives immediate feedback
5. exactly one logical event is created
6. the same sequence-numbered event is retransmitted a bounded number of times
7. gateway badge receives at least one copy
8. master Pi deduplicates it into one action

