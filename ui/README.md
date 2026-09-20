# Burger Level UI

This directory contains the local, offline-first HTN26 spectator and host UI MVP. The browser surface is a React application styled with Tailwind CSS; the only runtime assets are files in this directory, and it makes no internet requests. The current/latest companion development server is the root [`server/`](../server/) surface; keep browser integration pointed at that server rather than creating another server under `pi/`.

## Run locally

Requires Node.js 20 or newer.

```sh
cd ui
npm test
npm run dev
```

`npm run build` creates the production bundle in `dist/`.

Open <http://127.0.0.1:4173>. The default page uses the mock transport and
needs no provider key. Its executable offline flow is:

1. `Start` host mode.
2. `Scan Room` to show the proposed floor plan.
3. `Approve Layout` (the existing `Accept Layout` protocol alias) to accept the plan and generate burger-level placement instructions.
4. Place the cheese, lettuce, meat, and bun sources, the chopping boards, stoves, and serving badge as shown.
5. `Start Game` for a roughly two-minute round.

For the active camera flow, start the root server with `OPENAI_API_KEY` and
open `http://127.0.0.1:4173/?transport=http`. The scan step becomes a 3-5-photo
picker; the browser preprocesses all photos and sends one multipart generation
request. The mock has no `generateLayout` capability, so it intentionally keeps
the `Scan Room` command instead of showing a broken generation control.

The mock also supports delivery fixtures for tests (`DELIVERY_SUCCESS` and `DELIVERY_FAILURE`). The UI renders the serving result and score supplied by the transport; it does not create a delivery result itself.

## Product flow

The master Pi remains authoritative. The UI mirrors this flow:

```text
host Start
  -> choose 3-5 classroom photos
  -> one laptop-server AI generation request
  -> complete proposed room layout
  -> host approves floor plan
  -> burger level placement instructions
  -> two-minute burger round
  -> topping-variation orders and player state from snapshots
  -> serving badge validates completed burger
```

A burger uses buns, meat, cheese, and lettuce. Cheese, lettuce, and meat can be cut at chopping boards before assembly. Stoves expose authoritative cooking progress. There is no dish-washing station. The serving panel shows a line of standing Waterloo geese beside the serving location.

## Architecture and transport seam

`src/main.js` depends only on this transport interface:

```js
{
  connect(onState) -> cleanup | Promise<cleanup>,
  command(action) -> Promise<state>,
  generateLayout(files) -> Promise<state>, // optional capability
  close() // optional
}
```

- `src/mock-transport.js` is the required offline development transport. It owns a fixture state and applies host commands as a stand-in for the master Pi; it deliberately does not advertise `generateLayout`.
- `src/transport.js` includes the laptop-server HTTP/SSE transport. It expects `GET /api/state`, `POST /api/command`, `GET /api/events`, and `POST /api/layout/generate` from root `server/`.
- Use `http://127.0.0.1:4173/?transport=http` to select the HTTP seam. A supplied `window.__HTN26_TRANSPORT__` takes precedence for integration tests.
- `src/App.js` contains the React component tree for the staged setup flow, framed room board, order HUD, player/station overlays, and live notifications.
- `src/render.js` renders the same React tree to static markup for contract tests. It does not create timers, move players, score deliveries, or infer station/order state.
- The gameplay display includes the Figma-derived order queue, goose-coin score rail, and round timer. Up to four cards come from `orders`; `order` remains the legacy primary-order fallback. The timer is redrawn from authoritative `clock` snapshots and is never decremented by the browser.
- `assets/` contains the downloaded Figma stopwatch SVGs, the current badge ingredient PNGs, and the gameplay room background used behind the accepted room mirror. Higher-quality ingredient illustrations or a revised room background can replace those files without changing the HUD markup or state contract.

The renderer uses three display modes so setup controls do not compete with the live game display:

- `setup`: host controls, the room mirror, and physical burger-level placement instructions. An AI `proposedRoomLayout` is rendered as the complete unaccepted review surface; `roomLayout` is rendered after explicit approval.
- `gameplay`: one framed room board with up to four active orders across the top, the score at bottom-left, the round clock at bottom-right, and player/station/status overlays from the snapshot. Operator health chrome is intentionally excluded from the player-facing HUD.
- `results`: the completed round, score, serving result, and final room mirror.

The frontend snapshot boundary is defined in `src/contracts.js`. `version: 2`
is the stable schema version; it is independent of the monotonic `revision`
used to order full HTTP/SSE snapshots. The canonical snapshot contains
`setup`, `floorPlan`, `burgerLevel`, `players`, `order`, `stations`, `score`,
`clock`, `serving`, and `health`. Root server snapshots also carry
`proposedRoomLayout`, approved `roomLayout`, `timer`, `orders`,
`activeOrders`, `submissions`, `gold`, and `tips`.

`setup.phase` follows `idle` -> `scanning` -> `layout-proposed` ->
`burger-placement` -> `running` -> `ended`, with reset returning to `idle`.
`proposedRoomLayout` is review-only; approval moves it to `roomLayout` and sets
`floorPlan.accepted`. `START_GAME` remains unavailable before that transition.

Optional `orders` may retain completed history but contain no more than four
active objects with unique IDs. Cards expose server-supplied remaining time and
patience; `order` is the legacy first-active alias. `timer` and `clock` are
authoritative aliases and are never decremented in the browser. Submission,
serving, score, gold, and tip fields are displayed without local validation or
reward calculation.

`floorPlan.coordinateSpace` is `normalized-percent`; dimensions are positive
and wall/station rectangles fit the 0-100 range. AI room-layout rectangles use
their separate 0..1 center/size/rotation contract and are rendered completely
before and after approval, with optional debug IDs. Each player may supply a
0-100 `position`, `heldItem`, `actionState`, inventory, and tracking status. A
fixture may retain `simulatedLocation`, but an adapter must project it into
`position`; the UI does not treat it as camera evidence. Missing `position`
shows tracking unavailable rather than inventing a location.
Gateway, inference, and worker health remain integration data, not gameplay
authority. Invalid snapshots render an error state instead of partial data.

Authoritative values stay explicit:

- `floorPlan.accepted`, `floorPlan.stations`, and `burgerLevel.placementInstructions` describe the accepted map and where the physical burger level belongs.
- `players[].position` and `players[].tracking.lastSeenAt` are transport observations. The current phone photos are setup-only and do not provide live positions. Missing players are rendered at no fabricated location; stale health remains available through accessible labels. Player tokens never animate between snapshots.
- `orders[].remainingSeconds`, `order.remainingSeconds`, `clock.remainingSeconds`, station `progress`, and cooking state are displayed values from the master snapshot. The UI never decrements them locally.
- `health.gateway`, `health.workers`, and `health.inference` remain available to the host integration, but system-health warnings are intentionally excluded from the player-facing gameplay HUD.
- `stations[].item`, `stations[].status`, and `stations[].remainingSeconds` are rendered directly on their physical boards or plates. Empty stations explicitly show `EMPTY`; the player-facing screen has no separate live-activity feed.
- `serving.lastEvent` remains available to results/integration surfaces, while `score` is rendered exactly as delivered by the transport.

## Tests

```sh
npm test
```

Tests use only Node's standard library and cover the setup/gameplay/results display modes, aligned station and placement data, missing/stale tracking, stale worker health, invalid normalized coordinates, host scan/approval/start/end/reset transitions, invalid actions, duplicate deliveries, and serving/score success and failure updates.
