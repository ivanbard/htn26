# Burger Level UI

This directory contains the local, offline-first HTN26 spectator and host UI MVP. It is a dependency-free browser application: the only runtime assets are files in this directory, and it makes no internet requests.

## Run locally

Requires Node.js 20 or newer.

```sh
cd ui
npm test
npm run dev
```

Open <http://127.0.0.1:4173>. The development page uses a typed mock master-Pi adapter and a static floorplan fixture. Try the host flow:

1. `Start` host mode.
2. `Review Fixture` to review the static four-station floorplan (pantry, fridge, cutting board, and stove).
3. `Approve Layout` to accept the fixture and show burger-level placement instructions.
4. Start the roughly two-minute round and mirror the three fixed players, orders, and submissions.

For a laptop on the same local network as the Pi, run `HOST=0.0.0.0 npm run dev` on the host machine and open `http://<PI_OR_LAPTOP_IP>:4173/?transport=http` from the laptop. The expected Pi server contract is same-origin `GET /api/state`, `POST /api/command`, and `GET /api/events`; this UI does not implement those endpoints.

The current product uses simultaneous-shake submission. The UI renders results,
gold, and tips supplied by the transport; it does not validate plates or
create authoritative outcomes itself.

## Product flow

The master Pi remains authoritative. The UI mirrors this flow:

```text
host Start
  -> static four-station floorplan review
  -> host approves floor plan
  -> burger level placement instructions
  -> two-minute burger round
  -> one-or-more active recipe orders and fixed player icons
  -> simultaneous-shake submission
```

A burger uses buns, meat, cheese, and lettuce. The four supported recipes are plain meat burger, cheeseburger, lettuce-meat burger, and cheese-lettuce-meat burger; every recipe includes meat. Orders expose authoritative three-segment patience and countdown values. There is no dish-washing station.

## Architecture and transport seam

`src/main.js` depends only on the adapter contract documented in `src/contract.js`:

```js
{
  connect(onState) -> cleanup | Promise<cleanup>,
  command({ type, payload? }) -> Promise<masterSnapshot>,
  close() // optional
}
```

- `src/mock-transport.js` is the required offline development transport. It owns a fixture state and applies host commands as a stand-in for the master Pi.
- `src/transport.js` includes a local HTTP/SSE transport for integration with the Pi server slice. It expects `GET /api/state`, `POST /api/command`, and `GET /api/events`; the endpoint owner and local server setup are [`pi/server/README.md`](../pi/server/README.md).
- Use `http://127.0.0.1:4173/?transport=http` to select the HTTP seam. A supplied `window.__HTN26_TRANSPORT__` takes precedence for integration tests.
- `src/render.js` is a pure renderer. It does not create timers, move players, score deliveries, or infer station/order state.

Authoritative values stay explicit:

- `floorPlan.accepted`, `floorPlan.stations`, and `burgerLevel.placementInstructions` describe the accepted static map and physical placement.
- Player cards remain at the bottom of the gameplay view; holdings, logical station/action status, and submission results come from the master snapshot. No camera position is claimed when tracking is unavailable.
- `orders[*].remainingSeconds`, `orders[*].patienceSegments`, `clock.remainingSeconds`, station `progress`, gold, and tips are displayed values from the master snapshot. The UI never decrements or invents them locally.
- Submission results and score are rendered exactly as delivered by the transport.

## Tests

```sh
npm test
```

Tests use only Node's standard library and cover the public rendered setup/live
flow, four recipe definitions, independent order cards and patience meters,
fixed-player holdings, host scan/approval/start/end/reset transitions, and
submission success and failure updates.
