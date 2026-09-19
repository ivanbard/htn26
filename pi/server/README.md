# Pi server slice (QNX-oriented)

This directory contains the first locally runnable HTTP/serial boundary for the
Raspberry Pi host. It is intentionally a small Node.js 20+ process so the
protocol and web behavior can be exercised on a workstation before a QNX image
is available. The existing `pi/master` engine remains the authoritative game
engine; this process is a web/projection adapter and must consume canonical
master results when that adapter is connected.

## Run locally

```sh
cd pi/server
node server.mjs --host 127.0.0.1 --port 8787
# or make it reachable on the LAN:
node server.mjs --host 0.0.0.0 --port 8787
```

Useful environment variables:

- `HTN26_BIND_HOST`, `HTN26_PORT`: bind address and port (CLI flags win).
- `HTN26_DATA_DIR`: persistent photo/metadata directory.
- `HTN26_SERIAL_DEVICE`: USB serial device, for example a QNX `/dev/ser*`
  path. `--serial DEVICE` is equivalent.
- `HTN26_ROUND_SECONDS`: round length, default 120.
- `HTN26_ORDER_INTERVAL_MIN_SECONDS` and
  `HTN26_ORDER_INTERVAL_MAX_SECONDS`: randomized order-spawn interval,
  default 8-35 seconds.
- `HTN26_MAX_ACTIVE_ORDERS`: active order-card limit, default 3.
- `OPENAI_API_KEY`: optional server-only image provider credential. It is
  never included in an API response or browser bundle.

The default floorplan provider is a deterministic local fixture for an
approximately 10 m x 10 m room with exactly four stations: pantry, fridge,
cutting board, and stove. The upload/review/provider seam is present for the
next camera/AI slice. When an OpenAI credential is configured, the replaceable
provider can send uploaded image bytes server-side and falls back visibly to
the same local fixture on missing/failed AI responses. No cloud service is
needed to run the first slice.

## Physical host-badge serial path

The expected logical gateway records are the existing badge contract:

```text
HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|42|H|START
HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|43|B|SUBMIT:CHEESEBURGER
HTN26|GW|UP|12|0
```

The parser searches for `HTN26|` anywhere in a line, accepts human-readable
prefix noise, validates MAC/RSSI/protocol/sequence/type/payload size, and
handles USB chunks that split a record across reads. The stream adapter is
shared by fixtures, `/api/serial`, and the physical device. Duplicate
`MAC + sequence` events are ignored by the projection.

On QNX, configure the USB serial device using the board's serial driver and
permissions, then run:

```sh
HTN26_SERIAL_DEVICE=/dev/ser1 HTN26_BIND_HOST=0.0.0.0 node pi/server/server.mjs
```

The exact `/dev/ser*` name, baud configuration, USB enumeration, and device
permissions are board-image-specific and are not asserted by host tests. The
startup log prints the selected device. If events do not appear, first check
that the device exists and is readable, check the QNX serial-driver/baud
configuration, then post a known fixture line to the local diagnostic route:

```sh
curl -sS -X POST http://127.0.0.1:8787/api/serial \
  -H 'content-type: application/json' \
  -d '{"line":"noise HTN26|GW|UP|1|0"}'
curl -sS http://127.0.0.1:8787/api/health
```

`/api/serial` is a development diagnostic and uses the same parser boundary;
production input should use `HTN26_SERIAL_DEVICE`.

## HTTP protocol

All responses are JSON except `/api/events`, which is server-sent events.
The existing UI HTTP transport can consume `GET /api/state`, `POST
/api/command`, and `GET /api/events`.

Setup and photos:

- `POST /api/photos`: raw still bytes (`image/jpeg`, `image/png`, or a fixture
  `application/octet-stream`) or a multipart field named `photo`/`photos`.
  Up to four photos are retained; three or four makes review-ready.
- `POST /api/floorplan/review`: runs the provider boundary and returns the
  reviewable four-station plan. For the static local fixture, the uploaded
  bytes are metadata only.
- `POST /api/floorplan/approve` with `{ "approved": true }`: approves the
  plan and enables `START_GAME`.
- `GET /api/photos`, `GET /api/floorplan`: inspect setup state.

Commands use `{ "type": "START_HOST|SCAN_ROOM|APPROVE_LAYOUT|START_GAME|END_GAME|RESET_GAME" }`.
`SCAN_ROOM` requires uploaded photos and runs the review provider, so the
existing UI flow can use its command seam. `POST /api/floorplan/review` is the
explicit equivalent. `APPROVE_LAYOUT` is also retained as a UI protocol alias.

Projection reads:

- `GET /api/state`: setup, floorplan, players, station projection, active and
  historical order cards, timer, gold, tips, submissions, and health.
- `GET /api/orders`: `{order, orders}`. `orders` contains cards with recipe,
  `issuedAt`, `deadlineAt`, `remainingSeconds`, and a three-segment
  `patience` meter. Multiple cards may be active; at least one is retained
  while a round runs.
- `GET /api/gold`, `/api/tips`, `/api/timer`, `/api/players`,
  `/api/submissions`: small browser-friendly projections.
- `GET /api/events`: SSE snapshots; clients should use the `version` field.

When the QNX master adapter is connected, pass it to `createRuntime` as
`authoritativeEngine`. Its `ingestBadgeEvent` and `submit` methods return the
canonical result and optional state snapshot; the HTTP projection mirrors that
snapshot. The local projection rules are retained as the workstation fixture
path until the QNX adapter is available.

Exactly four recipes are generated: `PLAIN_MEAT`, `CHEESEBURGER`,
`LETTUCE_MEAT`, and `CHEESE_LETTUCE_MEAT`. Every recipe contains meat; cheese
and lettuce are optional. A submission event should carry
`B|SUBMIT:<RECIPE_ID>` (the `SUBMIT:SUCCESS` value is retained only as a
compatibility fixture for a canonical upstream result). The server matches the
recipe against an active order, derives gold from the recipe, derives a tip
from remaining patience, consumes the submitting player's projected plate,
and records success/failure. Browser code cannot award gold or tips.

## Cloudflare Tunnel / LAN

For a temporary tunnel, keep the server local and let `cloudflared` connect to
it:

```sh
node pi/server/server.mjs --host 127.0.0.1 --port 8787
cloudflared tunnel --url http://127.0.0.1:8787
```

For a named tunnel, configure the tunnel ingress to
`http://127.0.0.1:8787` and run `cloudflared tunnel run NAME`; authenticate
`cloudflared` through its own login/credential flow. Do not put an OpenAI key,
tunnel token, or other secret in browser JavaScript, the UI query string, or
this repository. A tunnel endpoint is not automatically an authenticated
product endpoint; use Cloudflare Access or an equivalent private policy before
sharing it beyond the trusted demo network. Binding `0.0.0.0` is only needed
for direct LAN clients and does not embed a secret.

## Tests and QNX boundary

From this directory:

```sh
node --test test/*.test.mjs
```

The tests use a deterministic serial fixture and a temporary data directory to
cover noisy/chunked serial parsing, duplicate suppression, photo upload and
review/approval, order cards, recipe validation, gold/tip calculation, SSE,
and the browser projection routes. They do **not** prove QNX serial-driver
enumeration, baud settings, Node availability in a target image, phone-camera
capture, physical badges, or OpenAI connectivity. QNX integration still needs
on-target validation. The QNX-specific replacement point is
`src/serial-device.mjs`; it opens the configured device and feeds bytes into
the platform-independent parser.

## UI worker contract assumptions

The UI worker can keep its current transport seam and should:

1. Treat `GET /api/state` as authoritative and never decrement `timer` or
   order patience locally.
2. Render `activeOrders`/`orders` as cards; `order` is only the first active
   card compatibility alias. Use `patience.filledSegments` and
   `remainingSeconds` from the server.
3. Render `gold.total`, `tips.total`, `players`, and `submissions` exactly as
   supplied. A submission's `validation` and `status` are authoritative.
4. Use `POST /api/floorplan/approve` or the existing `APPROVE_LAYOUT` command;
   the proposed plan has metre coordinates and four station IDs.
5. Keep the existing fallback/mock transport for offline UI tests. The server
   currently exposes fixed player cards `p1`, `p2`, and `p3`; badge assignment
   may be added through `POST /api/players/assign`.

The server does not claim live camera player positions in this first slice.
