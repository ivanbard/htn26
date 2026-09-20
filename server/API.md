# HTN26 frontend API

This is the contract for the root laptop server and the burger-level UI. The
server owns timers, orders, chopping, cooking, plate validation, score, gold,
tips, penalties, and the round lifecycle. The UI renders server state; it does
not score or advance game state locally.

## Run it

Start the server in one terminal. The longer order patience keeps the full-game
fixture from expiring while it demonstrates cooking:

```sh
HTN26_ORDER_PATIENCE_SECONDS=180 \
HTN26_ORDER_INTERVAL_MIN_SECONDS=120 \
HTN26_ORDER_INTERVAL_MAX_SECONDS=120 \
node server/server.mjs --host 127.0.0.1 --port 8787
```

Start the UI against it:

```sh
cd ui
npm run dev
```

Open the Vite URL with `?transport=http&api=http://127.0.0.1:8787`.

The two fixtures target that server and use real wall-clock time:

```sh
node server/simulate-photos.mjs   # upload four fixture photos (or reuse existing ones) and approve layout
node server/simulate-game.mjs    # run setup, a round with one served burger and one wrong plate, then GAME_END
```

Use `HTN26_API_URL` for another server address:

```sh
HTN26_API_URL=http://192.168.1.20:8787 node server/simulate-game.mjs
```

## Transport and SSE

The browser transport does this:

1. `GET /api/state` and render the complete JSON snapshot.
2. Open `GET /api/events` with `EventSource`.
3. Listen for the named `state` event and replace the complete snapshot with
   `JSON.parse(event.data)`.

Example:

```js
const source = new EventSource(`${apiBase}/api/events`);
source.addEventListener("state", (event) => render(JSON.parse(event.data)));
source.onerror = () => showReconnectingState();
```

The response is `text/event-stream; charset=utf-8` with `Cache-Control: no-cache`.
The first frame is sent immediately:

```text
event: state
data: {"version":2,"revision":12,"setup":{...},...}

```

Every frame is a complete snapshot. There are no patches, event IDs, or
heartbeat events. `EventSource` automatically retries after a disconnect;
keep the last valid snapshot visible while reconnecting and call `close()` when
the UI is disposed.

`version` is the schema version and is currently `2`. `revision` is a
projection-owned monotonic freshness counter. It may skip numbers; it is not a
schema version. A later SSE frame replaces an earlier snapshot rather than
being merged into it.

## Lifecycle

| Phase | How it starts | UI behavior |
| --- | --- | --- |
| `idle` | Initial state or reset without a layout | Show setup entry point. |
| `scanning` | `START_HOST` or `SCAN_ROOM` | Ask for photos or offer the deterministic room. |
| `layout-proposed` | Photo generation or floorplan review | Show the proposed station layout and approval action. |
| `burger-placement` | `POST /api/floorplan/approve` | Show placement instructions for pantry, fridge, cutting board, and stove. |
| `waiting-for-host-start` | `START_GAME` | Tell the operator to press START on the physical host badge. This is normal, not an error. |
| `running` | Host serial START | Show timer, orders, players, stations, and results. |
| `ended` | Host serial END, `END_GAME`, or timer reaches zero | Show final results; offer reset. |

The browser's `START_GAME` only prepares the round. Production gameplay starts
when the host badge emits `HTN26|GAME|START_GAME|240|3`.

## Snapshot contract

`GET /api/state` and every SSE `state` event have this top-level shape:

```json
{
  "version": 2,
  "revision": 12,
  "source": "root-server-simulator",
  "setup": { "phase": "running", "message": "...", "updatedAt": "..." },
  "floorPlan": { "accepted": true, "coordinateSpace": "normalized-percent", "width": 100, "height": 100, "units": "percent", "walls": [], "stations": [], "placementInstructions": [] },
  "roomLayout": null,
  "proposedRoomLayout": null,
  "burgerLevel": { "status": "in-play", "recipe": "BURGER", "placementInstructions": [] },
  "photos": [],
  "players": [],
  "orders": [],
  "activeOrders": [],
  "order": null,
  "gold": { "total": 0, "earned": 0, "lastChange": 0 },
  "tips": { "total": 0, "earned": 0, "lastChange": 0 },
  "penalties": { "total": 0, "lastChange": 0 },
  "money": { "gold": 0, "tips": 0, "penalties": 0, "net": 0, "lastChange": 0 },
  "score": { "value": 0, "delivered": 0 },
  "timer": { "status": "running", "remainingSeconds": 230, "totalSeconds": 240 },
  "clock": { "status": "running", "remainingSeconds": 230, "totalSeconds": 240 },
  "submissions": [],
  "eventHistory": [],
  "serving": { "lastEvent": null, "gooseQueue": 4, "location": "SERVING" },
  "stations": [],
  "health": { "gateway": {}, "inference": {}, "trackingCoverage": "unknown", "workers": [] }
}
```

Important fields:

- `setup.phase`, `setup.message`, and `setup.updatedAt` drive the screen and
  operator copy.
- `floorPlan` is normalized to 0-100 coordinates. Its station types are
  `pantry`, `fridge`, `cutting-board`, and the physical `stove` zone.
- `roomLayout` is the approved AI layout; `proposedRoomLayout` is the pending
  proposal. Both are `null` when unused.
- `burgerLevel.status` is `not-generated`, `placement-ready`, `in-play`, or
  `ended`.
- `players` always contains the three fixed players (`p1`, `p2`, `p3`). Use
  `heldItem`, `hasPlate`, `plate`, `actionState`, `processing`,
  `simulatedLocation`, and `tracking`. A missing `position` means unavailable;
  setup photos are not live tracking.
- `orders` is order history; `activeOrders` is the active subset; `order` is
  the first active order or `null`. Recipes are `PLAIN_MEAT`, `CHEESEBURGER`,
  `LETTUCE_MEAT`, and `CHEESE_LETTUCE_MEAT`.
- `stations` reports `status`, `progress` (0..1), `remainingSeconds`, and
  `item`. Stove stations also report `startedAt`, `doneAt`, `warningAt`, and
  `burntAt`. Cooking states are `cooking`, `done`, `warning`, and `burnt`.
- `timer` and `clock` are authoritative. Do not decrement them in the browser.
- `submissions` and `serving.lastEvent` contain server-owned success/failure
  results. Use `gold`, `tip`, `penalty`, `message`, and `submittedPlate` for
  the result UI.
- `eventHistory` contains `{ id, type, message, at }` records.
- `health.gateway`, `health.inference`, and `health.workers` are diagnostics;
  inference health does not mean player tracking is available.

## Routes

### State reads

| Method and route | Returns |
| --- | --- |
| `GET /api/state` | Complete snapshot. |
| `GET /api/events` | SSE `state` events containing complete snapshots. |
| `GET /api/floorplan` | Current floor-plan projection. |
| `GET /api/layout` | Approved room layout, or `null`. |
| `GET /api/layout/submissions` | `{ submissions: [...] }` audit summaries. |
| `GET /api/photos` | Photo metadata, count, and `reviewReady`; compatibility route. |
| `GET /api/orders` | `{ order, activeOrders, orders }`. |
| `GET /api/timer` | `{ status, remainingSeconds, totalSeconds }`. |
| `GET /api/players` | `{ players: [...] }`. |
| `GET /api/stations` | `{ stations: [...] }`. |
| `GET /api/submissions` | `{ submissions: [...] }`. |
| `GET /api/history` | `{ events: [...] }`. |
| `GET /api/gold`, `/api/tips`, `/api/money` | Corresponding authoritative totals. |
| `GET /api/health` | `{ ok: true, state: health }`. |

### Commands and setup

`POST /api/command` accepts `{ "type": "COMMAND" }` and returns a complete
snapshot. It also accepts a bare command string or `{ "action": "COMMAND" }`.

| Command | Result |
| --- | --- |
| `START_HOST` | `idle`/`ended` -> `scanning`; clears layout acceptance. |
| `SCAN_ROOM` | Creates the deterministic local floorplan proposal. |
| `APPROVE_LAYOUT` / `ACCEPT_LAYOUT` | Activates proposal -> `burger-placement`. |
| `START_GAME` | Prepares the round -> `waiting-for-host-start`; does not start timer. It is idempotent if the host has already started the round, so a browser/serial race does not fail the setup flow. |
| `END_GAME` | Ends active round -> `ended`. |
| `RESET_GAME` | Clears round; returns to `burger-placement` if layout remains accepted, otherwise `idle`. |
| `RESET_TO_OPENING` | Clears an unstarted setup and returns to `idle`; rejects a running round with `409` rather than interrupting it. |

`POST /api/floorplan/review` accepts `{ "allowEmpty": true }` for a local
no-photo fixture and returns a `layout-proposed` snapshot.

`POST /api/floorplan/approve` accepts `{ "approved": true }` and returns the
activated snapshot. `approved: false` leaves the proposal unchanged.

`POST /api/layout/generate` accepts one multipart request with 3-5 `photos`.
The active UI sends 4 or 5 preprocessed JPEGs. The response is the layout
proposal itself, not a snapshot; call `/api/floorplan/approve` afterward.

`POST /api/photos` accepts compatibility multipart `photos` and returns stored
photo metadata. It does not generate a layout. The photo fixture uses this
route, then calls `/api/floorplan/review`.

`POST /api/players/assign` accepts `{ "mac": "AA:BB:CC:DD:EE:FF", "playerId": "p1" }`
and returns a complete snapshot.

### Development serial seam

`POST /api/serial` accepts `{ "line": "HTN26|..." }` and returns
`{ result, state }`. The frontend normally does not call it; it is how the
game fixture pretends to be the host badge/radio gateway.

Useful records:

```text
HTN26|GAME|START_GAME|240|3
HTN26|GAME|GAME_END|3
HTN26|1|PLAYER|1|PICKUP|RAW_MEAT
HTN26|1|PLAYER|1|CHOP|START
HTN26|1|PLAYER|1|CHOP|DONE|CHOPPED_MEAT
HTN26|1|PLAYER|1|STOVE|LEFT|PLACE
HTN26|1|PLAYER|1|STOVE|LEFT|STATUS|COOKING
HTN26|1|PLAYER|1|STOVE|LEFT|TAKE
HTN26|1|PLAYER|1|PLATE|BM--
HTN26|1|PLAYER|1|READY
HTN26|1|SUBMIT|1|BM--
```

Events before host START are ignored for gameplay. Invalid serial syntax is
returned inside `result` as `{ "ok": false, "error": "..." }` and does not
change the snapshot.

## Errors and frontend rules

Errors are `{ "error": "..." }`. Common statuses are `400` for malformed
input or invalid setup, `404` for an unknown route, `409` for too many stored
photos, `413` for oversized bodies, and `503` for unavailable AI layout
generation.

The frontend should fetch state, subscribe to SSE, replace complete snapshots,
use `setup.phase` for screen selection, and treat disconnects as recoverable.
It must not locally decrement timers, score plates, award money, invent player
positions, or merge partial state.
