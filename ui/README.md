# Burger Level UI

This directory contains a separate local, offline-first HTN26 spectator and host
UI prototype. Its browser surface is a React application styled with Tailwind
CSS; the only runtime assets are files in this directory, and it makes no
internet requests. The current v1 simulator instead serves its required plain,
no-CSS page directly from `pi/server`; see
[`../pi/server/README.md`](../pi/server/README.md).

## Run locally

Requires Node.js 20 or newer.

```sh
cd ui
npm test
npm run dev
```

`npm run build` creates the production bundle in `dist/`.

Open <http://127.0.0.1:4173>. The development page uses the mock laptop-server transport. Try the host flow:

1. `Start` host mode.
2. `Scan Room` to show the proposed floor plan.
3. `Approve Layout` (the existing `Accept Layout` protocol alias) to accept the plan and generate burger-level placement instructions.
4. Place the cheese, lettuce, meat, and bun sources, the chopping boards, stoves, and serving badge as shown.
5. Start the four-minute round from the host badge in production. The mock
   `Start Game` command provides the equivalent offline UI transition.

The mock also supports delivery fixtures for tests (`DELIVERY_SUCCESS` and `DELIVERY_FAILURE`). The UI renders the serving result and score supplied by the transport; it does not create a delivery result itself.

## Prototype flow

The production laptop server remains authoritative. The UI mirrors this flow:

```text
host Start
  -> phone-photo room setup
  -> proposed floor plan
  -> host approves floor plan
  -> burger level placement instructions
  -> four-minute burger round
  -> topping-variation orders and event-inferred player cues
  -> laptop server validates the submitted plate
```

A burger uses buns, meat, cheese, and lettuce. Cheese, lettuce, and meat can be cut at chopping boards before assembly. Stoves expose authoritative cooking progress. There is no dish-washing station. The serving panel shows a line of standing Waterloo geese beside the serving location.

## Architecture and transport seam

`src/main.js` depends only on this transport interface:

```js
{
  connect(onState) -> cleanup | Promise<cleanup>,
  command(action) -> Promise<state>,
  close() // optional
}
```

- `src/mock-transport.js` is the required offline development transport. It owns a fixture state and applies host commands as a stand-in for the laptop server.
- `src/transport.js` includes the local HTTP/SSE transport for the production laptop server. It expects `GET /api/state`, `POST /api/command`, and named `state` events from `GET /api/events`.
- Use `http://127.0.0.1:4173/?transport=http` to select the HTTP seam. A supplied `window.__HTN26_TRANSPORT__` takes precedence for integration tests.
- `src/App.js` contains the React component tree for the staged setup flow, framed room board, order HUD, event-inferred player state tokens, and station overlays.
- `src/render.js` renders the same React tree to static markup for contract tests. It does not create timers, move players, score deliveries, or infer station/order state.
- The gameplay display includes the Figma-derived order queue, goose-coin score rail, and round timer. Up to four cards come from `orders`; `order` remains the legacy primary-order fallback. The timer is redrawn from authoritative `clock` snapshots and is never decremented by the browser.
- `assets/` contains the downloaded Figma stopwatch SVGs, the current badge ingredient PNGs, and the gameplay room background used behind the accepted room mirror. Higher-quality ingredient illustrations or a revised room background can replace those files without changing the HUD markup or state contract.

The renderer uses three display modes so setup controls do not compete with the live game display:

- `setup`: host controls, the room mirror, and physical burger-level placement instructions.
- `gameplay`: one framed room board with up to four active orders across the top, the score at bottom-left, the round clock at bottom-right, and each player's name, held item, action, and submission state attached to that player's event-inferred location. Operator health chrome is intentionally excluded from the player-facing HUD.
- `results`: the completed round, cumulative authoritative score, gold, and tip totals, latest serving result, and final room mirror.

The frontend snapshot boundary is defined in `src/contracts.js` (schema version 2); `version` is the positive integer state revision used by SSE clients. Optional `orders` may retain completed history but must contain no more than four active objects, all with unique, non-empty IDs; `order` may be null before and after a round. The HTTP transport converts the laptop server's meter-based floor plan and `simulatedLocation` station IDs into the UI's `normalized-percent` display projection for initial GET, command, polling, and SSE snapshots. Its `width` and `height` are positive finite values, and wall/station `x`, `y`, `width`, and `height` values are normalized to the 0–100 range. Invalid snapshots render an error state instead of partially rendering authoritative data.

Authoritative values stay explicit:

- `floorPlan.accepted`, `floorPlan.stations`, and `burgerLevel.placementInstructions` describe the accepted map and where the physical burger level belongs.
- `players[].simulatedLocation`, `heldItem`, `inventory`, and `actionState` come from the laptop's badge-event projection. The transport maps each inferred station to its approved floor-plan location; collocated bump participants retain the same authoritative location and receive deterministic side-by-side visual offsets so both states remain readable. Tokens never claim camera tracking and never animate between snapshots.
- `orders[].remainingSeconds`, `order.remainingSeconds`, `clock.remainingSeconds`, station `progress`, and cooking state are displayed values from the laptop-server snapshot. The UI never decrements them locally.
- `health.gateway`, `health.workers`, and `health.inference` remain available to the host integration, but system-health warnings are intentionally excluded from the player-facing gameplay HUD.
- `stations[].item`, `stations[].status`, and `stations[].remainingSeconds` are rendered directly on their physical boards or plates. Empty stations explicitly show `EMPTY`; the player-facing screen has no separate live-activity feed.
- `submissions` and `serving.lastEvent` remain authoritative. Failed submissions expose the server's positive `25` penalty as a 25-point cost; successful submissions show their gold and tip rewards. The gameplay score rail and results summary render authoritative cumulative gold and tip totals while retaining the delivered score value.

## Tests

```sh
npm test
```

Tests cover the setup/gameplay/results display modes, aligned station and placement data, event-inferred player state, named SSE updates, invalid normalized coordinates, host scan/approval/start/end/reset transitions, invalid actions, duplicate deliveries, and serving/score success and failure updates. They are host-side behavior checks and do not validate physical badges, bumping, phone-camera capture, or QNX.
