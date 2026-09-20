# FILE: `/pi/README.md`

# Laptop server and QNX advisory sidecar

The current v1 authoritative server runs, is tested, and is deployed on the
captain's laptop. It receives the host badge's USB serial stream and serves the
local browser UI. A QNX Pi may run the isolated, optional difficulty service in
[`difficulty/`](difficulty/README.md), but QNX is not the game server and this
repository does not claim that sidecar was revalidated on QNX in this revision.

The current laptop server slice owns:

* setup-photo upload and provider adaptation
* authoritative game-state execution
* host-badge and UI transport, with the local web/serial boundary documented in
  [`server/README.md`](server/README.md)
* validation and local application of any bounded difficulty label returned by
  the optional QNX sidecar

The current v1 setup accepts still photographs from an Apple phone. Pi-hosted
inference, workers, and multi-camera responsibilities below remain possible
future seams, not the current deployment or current player-location tracking.

No AI inference required for gameplay should depend on the cloud. The optional
difficulty sidecar is local-network advisory inference; the game remains fully
functional when it is absent.

---

## Roles

### Optional QNX difficulty sidecar

`pi/difficulty/`

Runs separately from the laptop server and owns only OpenCV/NumPy inference for
four normalized features. Its versioned HTTP response contains one of `easy`,
`normal`, or `hectic` plus source/model metadata and latency. It cannot return
or mutate recipes, orders, timers, score, gold, inventory, submissions, room
layout, or badge state. The laptop queries it asynchronously and retains its
existing order policy whenever no valid response is ready.

This is the selective migration path for PR 22's model artifact and concept;
the old synchronous `pi/server` child-process integration and any QNX-first
server claim are superseded by the sidecar contract.

### Possible future master Pi/QNX adapter

`pi/master/`

Would own:

* authoritative game state
* USB gateway-badge serial input
* phone-camera setup inference
* station-zone evaluation
* orders
* authoritative round, cooking, and order timers (the host badge initiates the
  physical lifecycle and displays its local countdown)
* scoring
* health monitoring
* UI API

### Pi server slice

`pi/server/`

The server slice is the laptop-hosted HTTP/SSE and USB-serial boundary for the
current launch. It owns protocol adaptation, browser projections, photo
upload/review plumbing, the functional local game simulator, and the optional
label-only sidecar adapter; it does not replace the portable master engine as
the future authoritative-engine seam. QNX is only a possible future deployment
target for this authoritative server. Its routes,
serial setup, provider boundary, and validation limits are documented in
[`server/README.md`](server/README.md).

### Worker Pi

`pi/slave/`

The same worker software can be deployed to future additional camera Pis.

When enabled, each worker owns:

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

## Possible future QNX AI qualification

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

---

## Portable master engine

The implemented portable engine and its possible future Pi/QNX adapter are
owned by [`master/README.md`](master/README.md). Worker implementation and
validation details are owned by [`slave/README.md`](slave/README.md).
