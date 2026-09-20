# HTN26 - Overcooked IRL

## Current v1 product intent

HTN26 is a local cooperative cooking game inspired by Overcooked.

The first playable server runs on the captain's laptop and accepts setup photos
from an Apple phone.

The current setup path uploads Apple-phone room photographs to the laptop server.

QNX is only a possible future server target. The current run, test, and
deployment path does not require a Raspberry Pi or claim QNX validation.

The v1 round uses one host or gateway badge and exactly three fixed player badges.

Players receive unique player numbers before a round and do not join dynamically during play.

The game uses four NFC zones: pantry, fridge, cutting board, and stove.

The burger level uses buns, meat, cheese, and lettuce, with orders varying by required toppings.

The accepted clarifications in [`updates/UPDATE_v1.1.md`](updates/UPDATE_v1.1.md) supersede conflicting earlier planning text.

This README records product intent and system ownership, while component READMEs retain implementation-specific contracts.

## Source-of-truth hierarchy

Use these sources in this order for new work.

- [`updates/UPDATE_v1.1.md`](updates/UPDATE_v1.1.md) contains the accepted v1 gameplay clarifications and supersedes conflicting v1 planning details.
- [`updates/UPDATE_v1.md`](updates/UPDATE_v1.md) contains the four-zone, phone-photo v1 plan as updated for the laptop-hosted launch.
- [`README.md`](README.md) defines the current product intent, architecture, and ownership boundaries.
- [`badge/badge-app-guide.md`](badge/badge-app-guide.md) is authoritative for Hacker Badge capabilities and APIs.
- Component READMEs define implementation responsibilities and local validation.
- Existing tests and code define implementation details within their component boundaries.

Do not duplicate packet formats, badge APIs, or component state contracts in this file.

If a product summary here conflicts with a component implementation contract, keep the summary at the product level and update the owning component document only when implementation work requires it.

## v1 setup

1. Photograph the play area with the phone and upload the stills to the laptop server.
2. Run the server's setup provider to propose a floor plan.
3. Approve the proposed floor plan in the laptop-hosted local UI.
4. Generate the burger level and follow the placement instructions for the four NFC zones.
5. Connect the host badge to the captain's laptop and assign unique numbers to the three player badges.
6. Select host mode on the host badge and player mode on the other badges.
7. Start the round from the host badge.

The setup photographs define the level layout only.

The v1 product does not use the phone camera to maintain live player locations.

The plain simulator UI lists each player only under the server-inferred station
or center/default location, with their held item and explicit action state,
instead of claiming camera-tracked live locations.

## Hardware and ownership

```text
Apple phone setup photos
     |
     v
captain's laptop - setup provider, authoritative game state, cooking/order timers, and UI transport
     |
     v
host or gateway badge - radio and host controls
     |
     +-------------------+-------------------+
     v                   v                   v
player badge 1      player badge 2      player badge 3
```

The host badge is the gateway between the player badges and the laptop server.

The host badge initiates the physical round, shows its local four-minute
countdown, and emits the `START_GAME`/`GAME_END` lifecycle records. The laptop
server applies those records as authoritative start/end transitions and owns
the game countdown, reset, cooking and order timers, orders, score, and
submission results.

Player badges read NFC and motion input, provide local feedback, and report player intent.

The UI mirrors state from the laptop server and does not become a second game authority.

Badge API limits and gateway behavior belong to the badge guide and badge component READMEs.

Laptop-server and possible future Pi/QNX adapter boundaries belong to the [`pi/`](pi/README.md) component documentation.

UI transport and rendering boundaries belong to the [`ui/`](ui/README.md) component documentation.

## NFC zones and ingredient rules

The four NFC zones are pantry, fridge, cutting board, and stove.

With an empty hand, the pantry provides buns on the right selection and lettuce on the left selection.

With an empty hand, the fridge provides cheese on the right selection and raw meat on the left selection.

A button and NFC combination that is not valid flashes red briefly and reports an unknown button combination.

A player may hold an item indefinitely during the round unless a game action moves or discards it.

Holding B while shaking discards the held item and reports the drop.

At the cutting board, holding A while scanning the cutting-board zone starts the cutting action.

The cutting feedback advances through six light steps.

Releasing A before cutting finishes loses the cutting progress and reports a failed cut.

Cheese, lettuce, and meat may be cut for burger assembly when the active order requires them.

Raw meat must be cut before it can be placed on a stove.

The stove zone provides two logical stove positions selected as left or right.

Selecting a stove shows its current contents and progress on the badge and UI where the owning component supports that display.

An empty hand can pick up finished cooked meat from a stove.

A held piece of raw cut meat can be placed on an empty stove.

Cooking takes 15 seconds.

Cooked food remains in its done state for 2 seconds.

The warning period flashes for 3 seconds before the food becomes burnt.

A player must pick up burnt food with an empty hand and then discard it.

## Plate and badge-to-badge transfer rules

A player can pick up a plate with an empty hand or while holding platable items.

Picking up a plate puts any platable item currently held onto that plate.

After a player has a plate, picking up another platable item adds it to the plate.

A player holding a plate cannot pick up a non-platable item.

The bun is one object that includes both the top and bottom buns.

An item cannot be duplicated on a plate.

For v1, platable items are the bun, cooked meat, sliced lettuce, and sliced cheese.

When two badges touch, an item moves from a badge without a plate to a badge with a plate when the item is platable.

When that item is not platable, the two badges switch their held items instead.

When both badges have plates, their plate items are swapped.

When neither badge has a plate, their held items are swapped.

A player holding a plate and an empty-handed player both keep their inventories
when they touch.

The owning badge component README defines the event representation for these
interactions. Simulator-only inferred-location behavior belongs to
[`pi/server/README.md`](pi/server/README.md).

## Host start and end lifecycle

Events received before the host starts the game are ignored.

Pressing START on the host badge begins the round.

The host start action broadcasts the start state to all badges and reaches the
laptop server and UI through the gateway serial path.

Starting a round clears prior badge and game state before play begins.

The host badge shows a local countdown during the round; the laptop server's
countdown remains authoritative for game state and UI snapshots.

A round lasts approximately four minutes.

After the round duration, the host badge broadcasts game end to all badges and
the laptop server and UI.

Game end wipes held items, plates, timers, and other round state on every badge and in the authoritative game state.

The system should keep retrying a lost connection rather than treating a temporary reconnect as a product failure.

Connection reliability beyond this v1 behavior remains an implementation concern owned by the relevant component.

## Submission behavior

A player submits by holding A and shaking while holding a plate.

The other two fixed players must also be shaking at the same time, but they do not need to hold A.

A detected shaking state persists for one half second to cover the large change in g force during the gesture.

Submission consumes the plate whether the order succeeds or fails.

A correct submission completes the matching order and reports its score.

A failed submission applies a penalty and has no retry.

The badges broadcast the submission result and drop any remaining held items as part of the submission transition.

The UI displays orders, station-grouped player names, held items, explicit
chopping/action state, cooking progress, and the submission result without a
separate global player-card list.

The authoritative laptop-server projection applies the configured penalty, tip, or bonus-gold result for the submitted order; the UI displays that result and does not independently validate or score the plate.

## v1 radio assumption

For first playable validation, radio is deliberately treated as reliable enough for the expected local room and is not a product-level blocker.

This assumption does not redefine the restricted badge API, packet size, gateway framing, or implementation-level retry and deduplication behavior.

The actual radio and serial contracts remain owned by [`badge/badge-app-guide.md`](badge/badge-app-guide.md), [`badge/master/README.md`](badge/master/README.md), and [`badge/slave/README.md`](badge/slave/README.md).

The first playable acceptance test should therefore validate the full path before adding more recovery behavior.

## Validation boundaries

Use the laptop simulator validation documented in
[`pi/server/README.md`](pi/server/README.md) for the current server path.

Run the badge tests from the repository root as documented by the badge component READMEs.

Run `make -C pi/master test` for the portable master engine.

Run the worker CMake and CTest commands in [`pi/slave/README.md`](pi/slave/README.md) when changing the worker core.

Run `npm test` in `ui/` for the offline UI.

These commands validate host-side behavior and do not claim physical badge, phone-camera, or QNX hardware validation.

## v1 success criteria

1. The host badge starts a clean round for three fixed players.
2. The laptop server receives player NFC and motion intent through the gateway serial path.
3. The four NFC zones support the ingredient, cutting, and stove interactions above.
4. Plate transfer and duplicate prevention follow the v1 rules.
5. Cooking follows the 15-second, done, warning, and burnt timeline.
6. All three players can perform the simultaneous shake submission.
7. The laptop server accepts or rejects the submission once and the UI shows the result.
8. The host badge ends the round after approximately four minutes and all round state is wiped.
9. The first playable run completes on the captain's laptop using the reliable-enough radio assumption without cloud services.

## Repository layout

```text
badge/
  badge-app-guide.md
  master/
  native/
  nfc_display/
  slave/
  tests/
pi/
  common/
  master/
  slave/
ui/
updates/
FLOW.md
```

Keep shared implementation protocols in their existing component owners.

Do not introduce a second definition of a packet, badge API, or transport contract in the root README.
