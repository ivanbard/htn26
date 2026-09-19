# FILE: `/pi/README.md`

# Raspberry Pi / QNX System

All Raspberry Pis run QNX.

The Pi layer owns:

* embedded AI inference
* camera processing
* player tracking
* inter-node communication
* authoritative game-state execution
* health monitoring

No AI inference required for gameplay should depend on the cloud.

---

## Roles

### Master Pi

`pi/master/`

Owns:

* authoritative game state
* USB gateway-badge serial input
* its own camera pipeline
* AI inference for camera 1
* observations from worker Pis
* multi-camera position fusion
* station-zone evaluation
* orders
* timers
* scoring
* health monitoring
* UI API

### Worker Pi

`pi/slave/`

The same worker software is deployed to Pi 2 and Pi 3.

Each owns:

* one camera
* local AI inference
* local tracking
* camera calibration
* world-coordinate conversion
* health reporting
* observation transmission

Worker Pis never directly mutate game state.

---

## Language

Prefer C++ for the QNX embedded/camera/AI processes unless a specific supported QNX module requires another language.

Keep platform-independent game logic separated from QNX-specific device code where practical.

---

## AI requirement

At least one AI component must use a qualifying open-source AI module available from:

`https://oss.qnx.com/`

Before final submission, record:

```text
Qualifying QNX AI module:
Version:
Source URL:
Where used:
```

in this README.

Current MVP status:

```text
Qualifying QNX AI module: unresolved
Version: unresolved
Source URL: https://oss.qnx.com/ (candidate must be verified there)
Where used: not yet selected; the worker exposes an InferenceAdapter seam
```

Do not assume that merely using any open-source ML library satisfies the sponsor track.

---

## Camera pipeline

Target:

```text
camera
    ↓
capture frame
    ↓
on-device AI person detector
    ↓
local temporal tracking
    ↓
player identity association
    ↓
world-coordinate transform
    ↓
observation packet
```

Do not use facial recognition.

Prefer deterministic player identifiers attached to the player/badge.

---

## Shared world coordinates

Each camera is calibrated against the same physical play area.

Example:

```text
(0,0) -------------------------------- (6,0)
  |                                      |
  |             play area                |
  |                                      |
(0,4) -------------------------------- (6,4)
```

Every camera worker should ultimately report something like:

```json
{
  "player": 2,
  "x": 3.42,
  "y": 1.18,
  "confidence": 0.93
}
```

not just raw camera pixels.

Calibration data is node-specific and should be stored with each worker's configuration.

---

## Worker → master observations

Tracking telemetry is replaceable state, not an event log.

A dropped old frame is normally harmless because a newer observation supersedes it.

Suggested logical format:

```json
{
  "type": "tracking",
  "node": "pi2",
  "sequence": 8291,
  "timestamp_ms": 1938842,
  "players": [
    {
      "player": 2,
      "x": 3.42,
      "y": 1.18,
      "confidence": 0.93
    }
  ]
}
```

Use a lightweight local-network protocol.

Frequent tracking telemetry may use UDP if appropriate.

Control/configuration traffic may use a reliable protocol.

Do not expose this system to the public internet.

---

## Heartbeats

Each worker must periodically report health.

Logical example:

```json
{
  "type": "heartbeat",
  "node": "pi2",
  "timestamp_ms": 1938842,
  "camera": "healthy",
  "inference": "healthy",
  "fps": 8.4
}
```

The master marks a node stale after a bounded timeout.

Do not keep displaying stale positions as if they were current.

---

## Failure model

A failed worker should produce:

```text
node state: FAILED / STALE
coverage: DEGRADED
game: still running when possible
```

Do not:

* crash the master because a worker disconnects
* block the game loop waiting forever for one node
* extrapolate a player's location indefinitely
* silently accept location-sensitive actions with stale tracking

---

## Performance target

Do not optimize for maximum camera FPS.

Initial target:

* 5–10 useful AI/tracking updates per second per camera
* bounded inference
* bounded networking
* responsive game-state processing

Reliability and consistency are more important than 30/60 FPS.

# FILE: `/pi/master/README.md`

# Master Pi

## Role

The master Pi is the single authoritative controller for the game.

It runs QNX and is responsible for combining:

```text
badge intent
+
camera observations
+
game rules
=
authoritative state transition
```

No other component may directly decide final game state.

---

## Inputs

### 1. Gateway badge over USB serial

Expected embedded marker:

```text
HTN26|RX|<sender_mac>|<rssi>|<payload>
```

The serial parser must tolerate surrounding firmware/logging text and locate the `HTN26|` marker.

### 2. Local camera

The master Pi should run the same basic camera/AI pipeline as worker Pis.

### 3. Worker Pi observations

Receive world-space observations and heartbeat information from Pi 2 and Pi 3.

### 4. UI/operator commands

Examples:

* start game
* stop game
* reset game
* assign badge MAC to player
* load calibration
* load recipe set

Operator commands are never allowed to bypass invariants accidentally.

---

## Core state

Maintain explicit structures for:

### Player

```text
id
badge_mac
position
position_confidence
position_timestamp
current_zone
held_item
action_state
```

### Station

```text
id
type
zone
contents
processing_state
processing_deadline
```

### Order

```text
id
recipe
created_at
deadline
state
score_value
```

### System

```text
game_state
score
remaining_time
camera_health
gateway_health
```

---

## Badge event ingestion

For every badge event:

1. parse sender MAC
2. parse protocol/version
3. validate fields
4. deduplicate `(MAC, sequence)`
5. map MAC to player
6. create an internal intent event
7. evaluate game rules
8. update state at most once
9. publish resulting state to UI

Never allow malformed packets to crash the process.

---

## Deduplication

Player badges may deliberately retransmit an important event.

Therefore:

```text
AA:BB:... + sequence 42
```

must be accepted once.

Subsequent copies are ignored.

Maintain a bounded deduplication structure rather than an ever-growing set.

---

## Spatial validation

Location-sensitive actions require recent camera information.

Example:

```text
event:
Player 2 -> STN:CHOP1

required:
Player 2 physically inside CHOP1 zone

tracking:
last update < stale threshold
confidence >= threshold

result:
accept or reject
```

Never infer that scanning a station means the camera says the player is there.

NFC intent and camera location are independent evidence.

---

## Multi-camera fusion

Each camera can report the same player.

The master must combine observations based on:

* freshness
* confidence
* configured camera quality/coverage
* physical plausibility

Start simple.

A weighted average or choose-best-fresh-observation strategy is acceptable for the MVP.

Do not implement a complicated distributed tracking algorithm before the simple version works.

---

## Game-state processing

Game rules should be deterministic.

Given the same ordered sequence of validated events and timer expirations, the engine should produce the same result.

Separate:

* input parsing
* spatial validation
* game rules
* timers
* state publishing

Do not bury game rules inside camera code.

---

## Timers

Cooking and order timers belong on the master Pi.

Use a monotonic clock.

Do not trust player badge clocks for authoritative timing.

Examples:

```text
pot cooking completion
order expiration
round end
station cooldown
```

---

## Health monitoring

Track:

```text
gateway badge
camera 1
worker Pi 2
worker Pi 3
UI clients
```

Expose health to the UI.

Example:

```text
Gateway    HEALTHY
Camera 1   HEALTHY
Pi 2       FAILED
Pi 3       HEALTHY

Tracking coverage: DEGRADED
```

---

## Failure injection demo

The system should support a hackathon demonstration where a worker process/node is intentionally stopped.

Expected result:

1. heartbeat disappears
2. master marks worker stale
3. UI visibly reports degraded coverage
4. stale observations stop influencing game state
5. remaining system continues running

This is an important part of the QNX/reliability story.

---

## Non-goals

Do not initially implement:

* cloud synchronization
* facial recognition
* voice control
* complex physics
* distributed consensus between Pis
* master-Pi failover
* direct Pi-to-player-badge commands

# FILE: `/pi/slave/README.md`

# Camera Worker Pi

## Role

This directory contains the software deployed to every non-master Raspberry Pi.

The same binary/application should support multiple workers through configuration.

Examples:

```text
NODE_ID=pi2
CAMERA_ID=cam2
```

and:

```text
NODE_ID=pi3
CAMERA_ID=cam3
```

Each worker runs QNX.

---

## Responsibilities

A worker must:

1. initialize camera
2. capture frames
3. run qualifying/local AI inference
4. detect people
5. maintain local temporal tracks
6. associate tracks with known players when possible
7. convert positions into shared world coordinates
8. transmit fresh observations to master
9. emit heartbeats
10. expose basic diagnostic metrics

It does not run game rules.

It does not ingest badge events.

It does not own score, inventory, recipes, or timers.

---

## Tracking output

Output should contain:

```text
node
sequence
timestamp
player ID when known
world x
world y
confidence
```

If identity is unknown, report an unknown track rather than guessing a player.

---

## Player identification

Do not use facial recognition.

Preferred approach:

```text
AI person detection
+
visible deterministic badge/lanyard marker
=
player identity + position
```

If the marker is temporarily invisible, temporal tracking may preserve identity for a short bounded period.

Do not preserve uncertain identity forever.

---

## Calibration

Each worker has its own camera calibration.

Calibration maps image coordinates into the shared game-space coordinates used by the master.

Store calibration separately from code.

The worker should fail clearly if required calibration is missing rather than inventing coordinates.

---

## Networking

Tracking updates are frequent and replaceable.

Heartbeats are periodic.

The worker should never block inference indefinitely because the master is unavailable.

If the network fails:

```text
continue local capture/inference
drop/replace old outgoing observations
keep bounded memory
retry communication
```

Do not queue minutes of obsolete tracking frames.

---

## Diagnostics

Expose/log:

```text
camera status
inference status
inference latency
effective FPS
network status
last successful master send
known tracks
unknown tracks
```

Avoid logging every frame in normal operation.

---

## Definition of success

A camera worker is complete when:

1. boots under QNX
2. initializes supported camera
3. runs the qualifying AI pipeline locally
4. identifies/tracks at least one player
5. produces calibrated world coordinates
6. sends those coordinates to master
7. master marks worker healthy
8. killing the worker causes master health state to transition to stale/failed
