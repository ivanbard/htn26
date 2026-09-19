# Game UI

The UI is the primary visual representation of the game.

Think of it as the equivalent of the television screen in Overcooked.

Players interact physically with the room, badges, ingredients, stations, plates, and lights.

The UI mirrors that physical world digitally so players, spectators, and judges can immediately understand what is happening.

The UI does not own authoritative game state.

All authoritative state comes from the main QNX Raspberry Pi.

---

## Core Experience

The intended hosting flow is:

```text
host connects stationary badge
to main Raspberry Pi
        ↓
host starts game setup
        ↓
three cameras observe room
        ↓
vision system scans physical layout
        ↓
system generates proposed floor plan
        ↓
host reviews / accepts layout
        ↓
game floor plan is generated
        ↓
players start game
        ↓
UI becomes live Overcooked-style display
```

The setup process should feel like the physical room is being converted into a game level.

---

## Setup / Room Scan

Before starting a round, the cameras inspect the play area.

The system should attempt to determine:

* playable floor area
* walls / room boundaries when detectable
* important physical stations
* camera coverage
* predefined station markers or calibrated locations

The AI system generates a proposed simplified game floor plan.

The generated map does **not** need to be a photorealistic reconstruction.

The goal is to create a clean top-down game representation.

Example:

```text
REAL ROOM

camera observations
        ↓

GENERATED GAME MAP

┌─────────────────────────────────┐
│ INGREDIENTS      CHOPPING       │
│                                 │
│                                 │
│         PLAY AREA               │
│                                 │
│ STOVES              DELIVERY    │
└─────────────────────────────────┘
```

The host must be able to review the proposed layout before the game starts.

For the MVP, host approval may simply be:

```text
Accept Layout
Rescan
```

Do not let uncertain AI-generated geometry silently become authoritative.

---

## Game Start

Once the layout has been accepted, the game can start.

Starting the game initializes:

* players
* order generation
* score
* cooking timers
* camera tracking
* station state
* game clock

The physical room and the digital floor plan now represent the same game world.

---

## Live Game Screen

During gameplay, the primary screen should look and behave like an Overcooked spectator/game display.

The most important information is:

```text
orders
score
round timer
player locations
player-held items
station contents
cooking state
completed dishes
```

The floor plan stays visible while the game runs.

Example:

```text
┌─────────────────────────────────────────────┐
│ ORDER: TOMATO SOUP       00:58       240   │
│                                             │
│ INGREDIENTS          CHOP 1                 │
│                                             │
│       ● P1                                  │
│                         ● P2                │
│                                             │
│ POT 1  ████████░      DELIVERY              │
│                                             │
└─────────────────────────────────────────────┘
```

Player positions should update continuously from the camera/AI tracking system.

The UI should not perform its own tracking.

It renders positions supplied by the master Pi.

---

## Orders

Orders appear on the main screen.

Players do not need order information duplicated on their badges.

Each order should show:

* requested dish
* required ingredients where useful
* remaining time
* completed/failed state

Orders should be large and easy to understand from across the room.

---

## Cooking Timers

Cooking timers exist in authoritative game state on the main Pi.

The UI displays them visually.

However, players should **not have to stare at the screen to know whether something is cooked.**

Each physical cooking station has associated lights.

The physical lights represent cooking status.

Suggested behaviour:

```text
OFF
nothing cooking

YELLOW / PROGRESS
cooking

GREEN
ready

RED / FLASHING
overcooked / burning / failed
```

The screen mirrors exactly the same state.

For example:

```text
physical pot light:
GREEN

UI:
POT 1 — READY
```

The Pi/game-state engine must drive both from one authoritative timer.

Do not implement separate timers in the UI and hardware.

---

## Physical/Digital Mirror

A major goal of the project is that the UI should appear to be a digital mirror of the room.

For example:

```text
physical world:

P1 standing at chopping board
P2 at stove
pot cooking
tomato on player 1

            ↓ cameras + badges

digital world:

P1 icon at CHOP1
P2 icon at POT1
POT1 cooking: 64%
P1 carrying tomato
```

Spectators should be able to understand what players are doing simply by looking at the screen.

---

## Player Position Rendering

The camera system provides world-space coordinates.

The UI maps them onto the accepted floor plan.

Positions should move smoothly enough to be readable, but the UI must never fabricate authoritative positions.

If tracking becomes stale, visually indicate that.

For example:

```text
P2
TRACKING LOST
```

rather than continuing to animate the previous position forever.

---

## Dish Delivery

Delivery occurs physically.

A player completes a plate and carries it to the stationary gateway badge.

The plate contains an NFC tag.

The player taps that plate against the stationary badge.

The main Pi then validates the authoritative contents of that plate against the active orders.

If valid:

```text
ORDER COMPLETE
+100
```

The UI should make successful submissions highly visible.

Rejected submissions should also be clear.

Example:

```text
WRONG ORDER
```

The NFC tag identifies the physical plate.

The server owns the knowledge of what food is currently on that plate.

---

## System Health

The game screen may have a small health indicator, while a separate developer view can expose full system state.

Important states:

```text
gateway badge
camera 1
camera 2
camera 3
AI inference
worker Pi connectivity
```

During the QNX reliability demonstration, failures should be visible.

Example:

```text
CAMERA 2 LOST
TRACKING DEGRADED
GAME CONTINUING
```

This should not dominate the normal game UI but must be easy to demonstrate to judges.

---

## Operator / Host Mode

Before and between rounds, expose controls for the host.

At minimum:

```text
Scan Room
Accept Layout
Rescan
Start Game
End Game
Reset Game
```

Potential future controls:

```text
assign player badges
configure recipes
configure round length
edit detected station positions
view camera coverage
```

Do not mix debugging tools into the main spectator game view unless necessary.

---

## Architecture

The UI communicates only with the main Pi.

Suggested architecture:

```text
camera workers ──────┐
                     │
badge gateway ───────┼──> MAIN QNX PI
                     │        │
physical lights <────┤        │
                     │        ▼
                     │     UI state
                     │        │
                     └────────▼
                           SCREEN
```

The UI should consume coherent authoritative state from the master.

WebSocket or SSE is appropriate for live updates.

HTTP or equivalent local APIs may be used for host commands.

The UI must not require internet access.

---

## Important Rule

There must be exactly one authoritative source for:

```text
player position
inventory
plate contents
station state
cooking timers
orders
score
game clock
```

That source is the main QNX Pi.

The UI only renders it.

The physical station lights also consume that same state.

This prevents the physical world and screen from disagreeing.

---

## MVP UI

Do not start with a polished game renderer.

First prove:

```text
1. show accepted floor plan
2. show two tracked players
3. show one active order
4. show one pot
5. update pot timer
6. show score
7. show successful plate submission
```

Once the complete loop works, improve animations and visual design.

