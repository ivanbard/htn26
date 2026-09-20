# HTN26 laptop server

This directory is the only current HTTP/SSE, photo, provider, room-layout, and
browser-projection server. Run it on the laptop with the root `ui/`; there is no
competing server under `pi/`. The server owns the current setup proposal and UI
snapshot, while `pi/master` remains the authoritative owner of gameplay rules
and supplies canonical results when its adapter is connected.

OpenAI room-layout generation is a laptop-first hackathon path. It is not a
claim of QNX or on-device OpenAI support. The deterministic default layout is a
separate development/recovery path, and any QNX inference or difficulty
sidecar remains future-only.

## Run locally

At startup, `server.mjs` automatically loads `server/.env` without overriding variables already supplied by the shell. Copy `example.env` to `.env`, set `OPENAI_API_KEY` when needed, and keep the real `.env` out of Git. Serial attachment is deliberately CLI-only.

```sh
cd server
OPENAI_API_KEY=sk-... node server.mjs --host 127.0.0.1 --port 8787
```

Use `--host 0.0.0.0` only for a trusted LAN. Useful environment variables:

- `HTN26_BIND_HOST`, `HTN26_PORT`: bind address and port; CLI flags win.
- `HTN26_DATA_DIR`: persistent photo and audit-metadata directory.
- `HTN26_ROUND_SECONDS`: round length, default 240.
- `HTN26_ORDER_INTERVAL_MIN_SECONDS` and
  `HTN26_ORDER_INTERVAL_MAX_SECONDS`: randomized order-spawn interval,
  default 8-35 seconds.
- `HTN26_MAX_ACTIVE_ORDERS`: active order-card limit, default 3.
- `HTN26_ORDER_PATIENCE_SECONDS`: optional fixed patience for every order.
  Unset, an order waits 60 s plus 15 s per topping (plain 60, cheese or lettuce
  75, both 90). Patience is independent of the spawn interval.
- `OPENAI_API_KEY`: required for the active 3-5-photo AI flow and kept only in
  this server process. It may be omitted only for the deterministic path.
- `OPENAI_LAYOUT_TIMEOUT_MS`: bounded Responses request timeout in
  milliseconds, default 12000.

Order pacing: a round opens with exactly one order, another arrives after a
random 8-35 s gap while fewer than the cap are open, and if none are open the
next is issued at once, so the kitchen always has an order to work on. Serving
the last open order also brings the next immediately. An order that runs out of
patience expires with a penalty and is replaced the same way.
- `HTN26_DIFFICULTY_SIDECAR_URL`: optional QNX difficulty recommendation
  adapter. When absent or blank, the runtime does not create or call a sidecar
  client and uses the normal laptop order sequence.
- `HTN26_DIFFICULTY_SIDECAR_TIMEOUT_MS`: optional bounded sidecar timeout,
  default 200 ms; it has no effect when the URL is not configured.

The deterministic default is an approximately 10 m x 10 m room with exactly
four station types: pantry, fridge, cutting board, and stove. The UI can select
it through `POST /api/floorplan/review` when no photos arrive or personalized
generation is unavailable. The active camera flow uses
`POST /api/layout/generate`; the UI immediately activates the generated layout
and proceeds to burger-level placement, so the player-facing flow has no
separate confirm-layout screen. The approval route remains available for
operator/API compatibility.

## Host-badge serial adapter

The parser consumes the existing logical gateway records:

```text
HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|42|H|START
HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|43|B|SUBMIT:CHEESEBURGER
HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|000044|E|P2:PU:R
HTN26|GW|UP|12|0
```

It searches for `HTN26|` amid log noise, validates the record, handles USB
chunks that split a line, and suppresses duplicate `MAC + sequence` events.
Accepted game records are emitted by `server.mjs` as one JSON object per line,
which makes the serial log safe to pipe to another parser. For example:

```json
{"event":"game-event","at":"2026-09-20T12:00:00.000Z","kind":"host-control","framing":"legacy-game","control":"START","durationSeconds":240,"playerCount":3}
{"event":"game-event","at":"2026-09-20T12:00:01.000Z","kind":"player-action","framing":"canonical","protocolVersion":1,"playerId":"p1","action":"PICKUP","item":"RAW_MEAT"}
```

Only accepted game records are logged: host controls, player actions,
submissions, and legacy badge events. Gateway up/down diagnostics and malformed
or unrelated serial noise are not emitted as game-event log lines. The
`framing` and legacy badge fields preserve the original shortlist when a
physical record cannot be translated further.

For laptop serial integration, explicitly attach the discovered device on each
start:

```sh
node server/server.mjs --serial /dev/ttyUSB0
```

On POSIX hosts the adapter configures a real TTY as raw, no-echo, no-hangup
before reading it. This is required even though the file descriptor is opened
read-only: a TTY with kernel echo enabled can send every badge log line back to
the stock console, producing an `Unrecognized command` feedback loop. The
adapter refuses to read a POSIX TTY when that safety configuration fails.
Regular fixture files used by host tests are unaffected.

A plain `node server/server.mjs` never attaches a device, even if the inherited
environment or `server/.env` contains `HTN26_SERIAL_DEVICE`. This opt-in avoids
opening a connected ESP32 unexpectedly. The server-side code previously opened
the environment-selected path and its adapter retries after stream errors or
end-of-file; that is the available code evidence for repeated host access. It
does not establish the cause of any physical badge reboot.

The development-only `POST /api/serial` diagnostic remains available without a
physical attachment and uses the same parser:

```sh
curl -sS -X POST http://127.0.0.1:8787/api/serial \
  -H 'content-type: application/json' \
  -d '{"line":"noise HTN26|GW|UP|1|0"}'
curl -sS http://127.0.0.1:8787/api/health
```

## HTTP API

The detailed frontend contract is in [`API.md`](API.md). It covers lifecycle,
SSE behavior, snapshot fields, routes, serial fixtures, and the two frontend
simulation scripts.

Normal responses are JSON. Errors use `{ "error": "safe message" }` and do
not contain raw provider details. `/api/events` is an SSE stream. The browser
HTTP transport uses `GET /api/state`, `GET /api/events`, `POST /api/command`,
and `POST /api/layout/generate`.

| Method and route | Input | Successful output | Expected errors |
| --- | --- | --- | --- |
| `GET /api/state` | none | complete canonical UI snapshot | `500` generic server error |
| `GET /api/events` | `Accept: text/event-stream` optional | initial and subsequent `event: state` frames whose `data` is the complete snapshot | connection/transport failure |
| `GET /api/orders` | none | `{ "order": object, "orders": array }` | `500` generic server error |
| `GET /api/timer` | none | authoritative `{ status, remainingSeconds, totalSeconds }` | `500` generic server error |
| `GET /api/gold` / `GET /api/tips` | none | authoritative reward totals and last change | `500` generic server error |
| `GET /api/players` | none | `{ "players": [...] }` | `500` generic server error |
| `GET /api/submissions` | none | `{ "submissions": [...] }` | `500` generic server error |
| `GET /api/health` | none | `{ "ok": true, "state": health }` | `500` generic server error |
| `POST /api/serial` | JSON `{ "line": "HTN26|..." }` | parser result plus current `state`; invalid protocol records remain parser results | `400` missing/non-string line or invalid JSON |
| `POST /api/players/assign` | JSON `{ "mac": "AA:BB:CC:DD:EE:FF", "playerId": "p1" }` | updated snapshot | `400` invalid MAC/player or JSON |
| `POST /api/command` | JSON command described below | updated snapshot | `400` invalid JSON or HTTP `SCAN_ROOM`; `409` valid request that does not fit the current state (for example `START_GAME` before approval), with the reason in `error`; `500` unsupported command |

The command body is `{ "type": "COMMAND" }`. Supported server commands are
`START_HOST`, `SCAN_ROOM`, `APPROVE_LAYOUT` (alias `ACCEPT_LAYOUT`),
`START_GAME`, `END_GAME`, and `RESET_GAME`. `START_GAME` requires an explicitly
approved proposal. On this root server, `SCAN_ROOM` creates the deterministic
local proposal; the photo-backed path uses `POST /api/layout/generate` and
then approval. See [`API.md`](API.md) for the complete lifecycle.

### Photo, layout, and approval routes

| Method and route | Input | Successful output | Expected errors |
| --- | --- | --- | --- |
| `POST /api/layout/generate` | one `multipart/form-data` request with 3-5 `photos`; optional `X-HTN26-Photo-Preprocess-Ms` | sanitized layout proposal; commits public photo metadata, `floorPlan`, and `setup.phase = layout-proposed`, then publishes one SSE snapshot; request/audit IDs in headers | `400` wrong count/malformed multipart; `413` too large; `503` missing key, timeout, provider, body, or validation failure |
| `GET /api/layout` | none | approved `roomLayout`, or `null` before approval | `500` generic server error |
| `GET /api/layout/submissions` | none | `{ "submissions": [...] }` audit summaries | `500` generic server error |
| `POST /api/floorplan/review` | JSON `{ "allowEmpty": true }` for the no-photo fixture, otherwise previously uploaded compatibility photos | unaccepted deterministic `floorPlan` proposal | `400` no photos/invalid JSON; `500` provider failure |
| `POST /api/floorplan/approve` | JSON `{ "approved": true }` | updated snapshot with accepted plan and active `roomLayout` for AI output | `400` invalid JSON; `409` nothing proposed to approve (with the reason in `error`) |
| `GET /api/floorplan` | none | current deterministic or AI-derived floor-plan projection | `500` generic server error |
| `GET /api/photos` | none | deprecated cumulative-photo metadata with `Deprecation: true` | `500` generic server error |
| `POST /api/photos` | deprecated raw image or multipart compatibility upload | cumulative photo metadata with `Deprecation: true` | `400` empty/malformed; `409` more than five cumulative photos; `413` too large |

The active browser path preprocesses selected images in parallel, honors EXIF
orientation, limits the long edge to about 1280 px, and encodes JPEG at quality
0.76. It sends every image together in one server request. The server makes
exactly one OpenAI Responses request using `gpt-5.6-luna`, low reasoning, low
image detail, strict structured JSON, and no tools, web access, image
generation, prose response, or multi-call pipeline.

The normalized square layout has presentation/front oriented to `y=0` and
contains only `presentationArea`, `objects`, `playArea`, and `stations` at the
top level. Every rectangle uses `{ center: { x, y }, width, height,
rotationDeg }` in 0..1 space. Objects add unique `id`, `type`, and
`usableSurface`; stations add `supportObjectId` and contain exactly one each of
`pantry`, `fridge`, `cutting_board`, and `stove`. Local sanitization removes
unknown fields, non-finite geometry, duplicate object IDs/stations, invalid
support references, and out-of-bounds rotated rectangles, and supplies
deterministic missing-station fallbacks. A new generation replaces only the
unaccepted proposal. Approval promotes it; no layout-editing workflow exists.

Every attempt has its own timestamped
`HTN26_DATA_DIR/layout-submissions/<request-id>/` folder containing the 3-5
photos and safe metadata. `X-HTN26-Layout-Request-Id` and
`X-HTN26-Layout-Audit-Folder` expose its identity for manual audit or deletion.
Startup reconciles interrupted `processing` records as failures without
combining batches. Timing uses the selected compact schema in both `Server-Timing` and
`X-HTN26-Layout-Metrics`: `{ preprocessMs, requestMs, validationMs, totalMs }`.
`preprocessMs` is reported client preprocessing; `requestMs` covers the single
provider request and response-body consumption; `validationMs` covers local
structured-output validation; `totalMs` covers the full HTTP operation,
including photo upload and audit persistence. Stages that do not run remain
`null`; timing is intentionally not split into separate upload/body/audit
fields. The provider timeout defaults to 12 seconds; under 15 seconds is a
typical target, not a guarantee.

## Canonical UI snapshot

`version` is the stable schema version (`2`) and changes only for an
incompatible contract. `revision` is the projection-owned monotonic change
counter used to discard stale HTTP/SSE snapshots; it is not a schema version.
Each `state` SSE event carries the same complete shape as `GET /api/state`, so
a client replaces its prior snapshot rather than merging partial events.

The canonical fields and lifecycle are:

- `setup`: `{ phase, message, updatedAt }`. Phases move through `idle` ->
  `scanning` -> `layout-proposed` -> `burger-placement` -> `running` ->
  `ended`; reset returns to `idle`.
- `floorPlan`: the 0-100 `normalized-percent` renderer projection, including
  `accepted`, walls, station rectangles, and placement instructions.
  `proposedRoomLayout` contains an unaccepted normalized 0..1 AI layout;
  `roomLayout` is `null` until approval, then contains the approved layout and
  `proposedRoomLayout` becomes `null`.
- `timer` and `clock`: matching authoritative `{ status, remainingSeconds,
  totalSeconds }` values. `clock` is the UI name; clients never decrement it.
- `orders` and `activeOrders`: cards with recipe, issue/deadline,
  remaining/total seconds, and `patience: { segments, filledSegments,
  remainingSeconds, totalSeconds }`. `order` is the first-active compatibility
  alias.
- `players`: fixed player records with identity, optional `position` in 0-100
  display coordinates, inventory, `heldItem`, `actionState`, and tracking
  health. An optional fixture-only `simulatedLocation` may preserve a mock
  source location, but an adapter must project it into `position`; it is not
  evidence of phone-camera tracking. Missing `position` means unavailable and
  does not cause the UI to invent a location.
- `stations`: authoritative status, progress, remaining seconds, and
  item/contents, aligned by ID with the accepted floor plan. Stove records also
  retain `startedAt`, `doneAt`, `warningAt`, and `burntAt`; the server derives
  them once from the forwarded `ST:<side>:P` event and pushes projections over
  SSE, so reconnecting frontends receive the complete cooking timeline.
- `submissions`, `serving`, `score`, `gold`, and `tips`: authoritative
  validation outcomes and rewards. The browser never validates or scores a
  plate.
- `health.gateway`, `health.inference`, and `health.workers`: last-seen and
  status data. Setup-inference health does not imply live player tracking.

The deterministic fixture and current tests use this same lifecycle: review a
default proposal, approve it, then start. The 3-5-photo path differs only in
how the unaccepted proposal is produced.

When a master adapter is connected, pass it to `createRuntime` as
`authoritativeEngine`. Its badge-event and submission results are canonical;
the local projection rules remain a workstation fixture. Exactly four recipes
are generated: `PLAIN_MEAT`, `CHEESEBURGER`, `LETTUCE_MEAT`, and
`CHEESE_LETTUCE_MEAT`. Browser code cannot award gold or tips.

## Cloudflare Tunnel / LAN

For a temporary tunnel, keep the server local and let `cloudflared` connect to
it:

```sh
node server/server.mjs --host 127.0.0.1 --port 8787
cloudflared tunnel --url http://127.0.0.1:8787
```

Do not put an OpenAI key, tunnel token, or other secret in browser JavaScript,
the UI query string, or this repository. A tunnel endpoint is not
automatically authenticated; apply a private access policy before sharing it
beyond the trusted demo network.

## Tests and future QNX boundary

```sh
node --test test/*.test.mjs
```

Tests cover host-side serial parsing, duplicate suppression, uploads,
generation/audit behavior, review/approval, orders, rewards, SSE, and browser
projection routes. They do not prove QNX serial enumeration, Node availability
on a target image, phone capture, physical badges, OpenAI connectivity, or a
QNX sidecar.

The optional QNX difficulty director is a sidecar only: it may receive bounded
features and return bounded recommendations through `src/difficulty-sidecar.mjs`,
but it does not own HTTP routes, duplicate orders/timers/scoring, mutate state
directly, or become a second room-layout server. It is disabled unless
`HTN26_DIFFICULTY_SIDECAR_URL` is explicitly configured. A future QNX serial
adapter may replace `src/serial-device.mjs` while retaining the
platform-independent parser.
