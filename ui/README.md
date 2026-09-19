# Burger Level UI

This directory contains the local, offline-first HTN26 spectator and host UI MVP. It is a dependency-free browser application: the only runtime assets are files in this directory, and it makes no internet requests.

## Run locally

Requires Node.js 20 or newer.

```sh
cd ui
npm test
npm run dev
```

Open <http://127.0.0.1:4173>. The development page uses the mock master-Pi transport. Try the host flow:

1. `Start` host mode.
2. `Scan Room` to show the proposed floor plan.
3. `Approve Layout` (the existing `Accept Layout` protocol alias) to accept the plan and generate burger-level placement instructions.
4. Place the cheese, lettuce, meat, and bun sources, the chopping boards, stoves, and serving badge as shown.
5. `Start Game` for a roughly two-minute round.

The mock also supports delivery fixtures for tests (`DELIVERY_SUCCESS` and `DELIVERY_FAILURE`). The UI renders the serving result and score supplied by the transport; it does not create a delivery result itself.

## Product flow

The master Pi remains authoritative. The UI mirrors this flow:

```text
host Start
  -> camera room scan
  -> proposed floor plan
  -> host approves floor plan
  -> burger level placement instructions
  -> two-minute burger round
  -> topping-variation orders and live player positions
  -> serving badge validates completed burger
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

- `src/mock-transport.js` is the required offline development transport. It owns a fixture state and applies host commands as a stand-in for the master Pi.
- `src/transport.js` includes a local HTTP/SSE transport for integration with a master Pi. It expects `GET /api/state`, `POST /api/command`, and `GET /api/events`; those endpoints remain outside this UI task.
- Use `http://127.0.0.1:4173/?transport=http` to select the HTTP seam. A supplied `window.__HTN26_TRANSPORT__` takes precedence for integration tests.
- `src/render.js` is a pure renderer. It does not create timers, move players, score deliveries, or infer station/order state.

Authoritative values stay explicit:

- `floorPlan.accepted`, `floorPlan.stations`, and `burgerLevel.placementInstructions` describe the accepted map and where the physical burger level belongs.
- `players[].position` and `players[].tracking.lastSeenAt` are master-Pi observations. Missing or old observations are rendered at no fabricated location with a visible `TRACKING LOST` or `TRACKING STALE` marker. Player tokens never animate between snapshots.
- `order.remainingSeconds`, `clock.remainingSeconds`, station `progress`, and cooking state are displayed values from the master snapshot. The UI never decrements them locally.
- `health.gateway`, `health.workers`, and `health.inference` show gateway/camera/AI health. A stale worker produces a visible `TRACKING DEGRADED` callout.
- `serving.lastEvent` and `score` are rendered exactly as delivered by the transport.

## Tests

```sh
npm test
```

Tests use only Node's standard library and cover burger-level rendering, missing/stale tracking, stale worker health, host scan/approval/start/end/reset transitions, and serving/score success and failure updates.
