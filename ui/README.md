# Game UI

This directory contains the local, offline-first HTN26 spectator/host UI MVP. It is a dependency-free browser application: the only runtime assets are the files in this directory, and it makes no internet requests.

## Run locally

Requires Node.js 20 or newer (the built-in `node:test` runner is used).

```sh
cd ui
npm test
npm run dev
```

Open <http://127.0.0.1:4173>. The development page uses the in-process mock master-Pi transport, so the complete setup flow can be exercised without cameras, badges, or a network:

1. `Scan Room`
2. `Accept Layout`
3. `Start Game`
4. `End Game` or `Reset Game`

The mock is an authoritative **development fixture**, not UI-owned game state. The UI sends commands and renders the snapshots returned by its transport. The mock also exports delivery actions for fixture/tests; delivery results are rendered as success or rejection and only the mock master changes score.

## Architecture and transport seam

`src/main.js` only depends on a transport with this interface:

```js
{
  connect(onState) -> cleanup | Promise<cleanup>,
  command(action) -> Promise<state>,
  close() // optional
}
```

- `src/mock-transport.js` is the required offline development transport. It owns a fixture state and applies host commands as a stand-in for the master Pi.
- `src/transport.js` also includes a local HTTP/SSE transport for integration with a master Pi implementation. It expects `GET /api/state`, `POST /api/command`, and `GET /api/events`; those endpoints remain outside this UI task.
- Use `http://127.0.0.1:4173/?transport=http` to select the HTTP seam. The browser is still pointed at a local address; no cloud service or remote asset is involved. A supplied `window.__HTN26_TRANSPORT__` takes precedence for integration tests.
- `src/render.js` is a pure renderer. It does not create timers, move players, score deliveries, or infer station/order state.

The state contract intentionally keeps authoritative values explicit:

- `floorPlan.accepted` and `floorPlan.stations` describe the accepted top-down layout.
- `players[].position` and `players[].tracking.lastSeenAt` are master-Pi observations. A missing/old observation is rendered at its last known coordinates with a visible `TRACKING STALE` marker; it is never animated indefinitely.
- `order.remainingSeconds`, `clock.remainingSeconds`, and station `progress` are displayed values from the master snapshot. The UI never decrements them locally.
- `health.gateway`, `health.workers`, and `health.inference` show gateway/camera/AI health. A stale worker produces a visible `TRACKING DEGRADED` callout.
- `delivery.lastEvent` and `score` are rendered exactly as delivered by the transport.

The mock fixture is intentionally replaceable. A future master-Pi adapter can use WebSocket/SSE instead of the included HTTP polling fallback without changing the renderer or host controls.

## Tests

```sh
npm test
```

The tests use only Node's standard library and cover accepted-state rendering, stale player/worker health, setup command transitions, and delivery/score success and failure rendering.
