# HTN26 headless server simulator

`pi/server` is the laptop-hosted v1 simulator and HTTP/serial boundary. For the
current launch it runs on the captain's laptop, not QNX. It provides a complete
burger round while preserving an adapter seam for a possible future QNX master.
Browser code only renders snapshots; all clocks, order generation, patience,
station transitions, validation, and money changes happen in the server
projection (or in a connected authoritative engine).

## Run on the captain's laptop (current path)

Install Node.js 20 or newer on the laptop. No package installation is needed.

```sh
cd pi/server
node server.mjs --host 127.0.0.1 --port 8787
```

Open <http://127.0.0.1:8787/>. The server serves a deliberately plain HTML page
with no CSS or frontend framework. Active/new orders are first, round and timer
status follow, player/station/submission/history state is inspectable, and gold,
tips, penalties, and net money are at the bottom. The page consumes
`GET /api/state` and `GET /api/events`; it never runs game rules or decrements a
clock itself.

The page includes a serial-line form and start/end/reset buttons. The startup
log also prints copy-paste browser-console examples using the canonical
`HTN26|1|...` protocol, followed by examples for querying timer, orders,
players, submissions, and money.

To listen on a trusted local network:

```sh
node server.mjs --host 0.0.0.0 --port 8787
```

Configuration:

- `HTN26_BIND_HOST`, `HTN26_PORT`: bind address and port; CLI flags win.
- `HTN26_DATA_DIR`: persistent photo/metadata directory.
- `HTN26_SERIAL_DEVICE`: laptop USB serial device, such as Linux
  `/dev/ttyACM0`; `--serial DEVICE` is equivalent.
- `HTN26_ROUND_SECONDS`: default round duration, normally 240.
- `HTN26_ORDER_INTERVAL_MIN_SECONDS` and
  `HTN26_ORDER_INTERVAL_MAX_SECONDS`: randomized natural order-spawn interval,
  default 8-35 seconds.
- `HTN26_ORDER_PATIENCE_SECONDS`: optional fixed order lifetime. If omitted,
  each order gets a lifetime from the same configured interval range.
- `HTN26_MAX_ACTIVE_ORDERS`: active-order limit, default 3.
- `HTN26_PLAYER_LOCATION_HOLD_SECONDS`: how long an inferred station visit
  remains visible after an instant/finished action, default 2 seconds.
- `OPENAI_API_KEY`: optional server-only floorplan provider credential; it is
  never returned to the browser.

## Canonical serial protocol v1

Every canonical record is printable, pipe-delimited, newline-terminated on a
physical stream, and starts with `HTN26|1|`. The development endpoint accepts
one record as `POST /api/serial` with `{ "line": "..." }`. Prefix logging noise
is tolerated because the parser searches for `HTN26|` in each line.

### Host lifecycle

```text
HTN26|1|HOST|START
HTN26|1|HOST|START|240|3
HTN26|1|HOST|END
HTN26|1|HOST|RESET
```

`START` clears prior round inventory, plates, stations, orders, submissions,
economy, and history, then starts a clean round for the three fixed players.
The duration/count form requires 1-3600 seconds and exactly three players. The
short form uses `HTN26_ROUND_SECONDS`. For local serial simulation, host START
accepts the deterministic four-station fixture if a floorplan has not already
been approved. The HTTP setup command `START_GAME` still requires normal
floorplan approval.

`END` marks active orders cancelled, sets the timer to ended/zero, and clears
player and station round state. Natural timeout performs the same cleanup.
`RESET` returns to ready state with no active order and zeroed money while
retaining the selected floorplan and badge assignments.

### Gateway status

```text
HTN26|1|GATEWAY|UP|12|0
HTN26|1|GATEWAY|DOWN|12|2
```

The final fields are non-negative forwarded-packet and dropped-packet counts.
They update health only and do not mutate gameplay.

### Player actions

Player numbers are always `1`, `2`, or `3`.

```text
HTN26|1|PLAYER|1|PICKUP|BUN
HTN26|1|PLAYER|1|PICKUP|RAW_MEAT
HTN26|1|PLAYER|1|PICKUP|RAW_LETTUCE
HTN26|1|PLAYER|1|PICKUP|RAW_CHEESE
HTN26|1|PLAYER|1|PLATE|NEW
HTN26|1|PLAYER|1|PLATE|BM--
HTN26|1|PLAYER|1|CHOP|START
HTN26|1|PLAYER|1|CHOP|DONE|CHOPPED_MEAT
HTN26|1|PLAYER|1|CHOP|FAIL
HTN26|1|PLAYER|1|STOVE|LEFT|PLACE
HTN26|1|PLAYER|1|STOVE|LEFT|TAKE
HTN26|1|PLAYER|1|STOVE|RIGHT|CHECK
HTN26|1|PLAYER|1|STOVE|RIGHT|STATUS|WARNING
HTN26|1|PLAYER|1|DROP
HTN26|1|PLAYER|1|LEAVE
HTN26|1|PLAYER|1|TRANSFER|2
HTN26|1|PLAYER|1|READY
```

Accepted item names are `BUN`, `RAW_MEAT`, `CHOPPED_MEAT`, `COOKED_MEAT`,
`RAW_LETTUCE`, `LETTUCE`, `RAW_CHEESE`, `CHEESE`, and `BURNT_MEAT`.
`STATUS` accepts `EMPTY`, `COOKING`, `DONE`, `WARNING`, or `BURNT`, but it is a
reported diagnostic only: it cannot overwrite the server's stove timer.
`CHECK` likewise reads the authoritative station phase.
`DONE` is a diagnostic completion report: it cannot finish chopping before the
server's three-second deadline. The server timer completes the chop even if no
`DONE` report arrives.

A plate summary always has four fixed `BMLC` columns: bun, cooked meat, sliced
lettuce, and sliced cheese. A dash means absent, so a plain burger is `BM--`
and a fully topped burger is `BMLC`. `PLATE|NEW` takes an empty plate or moves a
currently held platable item onto one. Duplicate and raw plate items are
rejected. `TRANSFER` applies the v1 merge/swap rules to the two authoritative
player inventories. `READY` remains visible for the 0.5-second shake window.

Player actions received while no round is running are recorded as ignored and
do not mutate inventory. `LEAVE` starts the same documented return delay for
the player's current inferred station.

### Action-inferred station occupancy

The simulator does not claim live camera tracking. It exposes each player's
`currentStation` and `simulatedLocation` as a temporary inference from accepted
serial actions:

- bun/lettuce source actions infer Pantry; meat/cheese source actions infer
  Fridge;
- chop actions infer Cutting Board;
- left/right stove actions infer Stove 1/Stove 2; and
- a submission infers Serving.

Every instant action and every finished/failed timed action remains under that
station for 2 seconds by default, then the server returns the player to
`center` / `CENTER / DEFAULT`. `simulatedLocation.returnAt` makes that deadline
inspectable, and `HTN26_PLAYER_LOCATION_HOLD_SECONDS` changes it. Chopping stays
at Cutting Board through its three-second operation and then uses the return
delay. A later action moves the player immediately to its newly inferred
station. Occupancy is stored per player, so any station can list multiple
players at once. The plain page shows player names and authoritative action
text under Pantry, Fridge, Cutting Board, Stove 1, Stove 2, Serving, and the
center/default group.

### Submission

```text
HTN26|1|SUBMIT|1|BM--
HTN26|1|SUBMIT|2|CHEESEBURGER
```

The last field is normally the submitted `BMLC` plate summary; recipe IDs are
also accepted as assertions. `SUBMIT` counts as the submitting player's shake;
the other two fixed players must each have sent `READY` within the same
0.5-second server window. Arrival order does not matter: an early `SUBMIT` is
held only until that window closes. The submitter must hold an authoritative server
plate, and the submitted summary or recipe must match that plate. The server
never constructs inventory from the submission payload. Once consensus and the
assertion pass, the server matches its plate against active orders and clears
all three players' held state. A successful early order awards recipe gold and
a positive server-calculated tip. A wrong or already expired order applies a
penalty. Missing consensus, missing inventory, and assertion mismatches are
rejected without scoring. The browser cannot provide a score or validation
result.

## Legacy badge compatibility

The canonical grammar above is preferred for new host integrations and browser
console diagnostics. The parser continues to accept all current physical-badge
frames:

```text
HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|42|H|START
HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|43|B|SUBMIT:CHEESEBURGER
HTN26|RX|AA:BB:CC:DD:EE:FF|-48|OC1|000044|E|P2:PU:R
HTN26|GW|UP|12|0
HTN26|GAME|START_GAME|240|3
HTN26|GAME|GAME_END|3
```

`RX` validation preserves the 44-byte `OC1` payload bound, MAC/RSSI checks,
32-bit sequence checks, and `(MAC, sequence)` duplicate suppression. The full
fixed-player `E|P<player>:<action>` vocabulary is translated:

- `PU:B|R|Q|K` and the cooked/chopped item codes update the hand.
- `PL:NEW` and `PL:<BMLC>` update the plate.
- `CH:S`, `CH:F`, and `CH:D:M|L|C` update chopping.
- `ST:L|R:P|T|X` and `ST:L|R:C:<phase>` update/check the two stoves without
  letting a reported phase override server time.
- `DROP:<snapshot>`, paired `X:<snapshot>`, `READY`, and `SUB:<BMLC>` map to
  drop, transfer, shake readiness, and submission.

The encoded player number in an `E` event wins over radio arrival order. Legacy
`N`, `M`, `B`, and `H` fixture intents remain parse-compatible. Legacy
`B|TIP:<amount>` claims are recorded diagnostically and ignored; only a
successful authoritative submission can award a tip. `GW` status and `GAME`
lifecycle records map to the same internal operations as canonical records.
USB chunks can split records at any byte boundary.

The host and player badge profiles themselves are owned by
[`../../badge/master/README.md`](../../badge/master/README.md),
[`../../badge/slave/README.md`](../../badge/slave/README.md), and the
whole-fleet native safety gate in
[`../../badge/native/README.md`](../../badge/native/README.md). Do not mix Lua
and native radio profiles.

## Authoritative simulator rules

- A round defaults to 240 seconds and publishes integer countdown snapshots.
  End/timeout clears held items, plates, chopping, and both stoves.
- Burger orders appear immediately at start and naturally at randomized
  intervals up to the active-order limit. Recipes cycle through `PLAIN_MEAT`,
  `CHEESEBURGER`, `LETTUCE_MEAT`, and `CHEESE_LETTUCE_MEAT`.
- Patience is authoritative `3`, `2`, `1`, then `0` at expiration, using thirds
  of the order lifetime. Expiration marks the order and subtracts 20 money.
- A wrong submission subtracts 25 money. Gold is 100/120/120/150 by recipe.
  Tips are 20%, 10%, or 5% of recipe gold in patience tier 3/2/1, with a
  minimum positive tip for a successful active order.
- Submission requires the submitter's authoritative plate plus all three fixed
  players' fresh 0.5-second shake state. A submitted BMLC/recipe value is only
  a consistency assertion and cannot create or replace server inventory.
- `money.net = gold + tips - penalties`; `score.value` mirrors net money.
- Chopping takes 3 seconds. Releasing/failing before completion loses progress
  while retaining the raw item.
- Each logical stove is independent: 15 seconds cooking, 2 seconds done,
  3 seconds warning, then burnt. The protocol's left/right sides are displayed
  as Stove 1/Stove 2. Only chopped meat can be placed. Cooked meat can be taken
  during done/warning; burnt meat must be taken and dropped.
- Action-inferred station occupancy uses the documented temporary hold and is
  not camera or physical-position evidence.
- Event history records round lifecycle, orders, actions/rejections, station
  phases, submissions, gateway state, and money penalties. Histories and other
  public arrays are bounded.

## HTTP, JSON, and SSE

The complete authoritative snapshot is available at `GET /api/state` and as
`state` events from `GET /api/events`. Focused projections are:

- `GET /api/timer`
- `GET /api/orders` (`order`, `activeOrders`, and historical `orders`)
- `GET /api/players`
- `GET /api/stations`
- `GET /api/submissions`
- `GET /api/history`
- `GET /api/gold`, `GET /api/tips`, and `GET /api/money`
- `GET /api/health`

Commands use `{ "type": "START_HOST|SCAN_ROOM|APPROVE_LAYOUT|START_GAME|END_GAME|RESET_GAME" }`
at `POST /api/command`. Badge assignment uses
`POST /api/players/assign`. `POST /api/serial` is a local development
diagnostic and passes its line through the exact same parser/dispatcher as the
physical stream.

A future UI should render `version`, `activeOrders`, `patience.filledSegments`,
`timer`, players (including `currentStation`/`simulatedLocation`), stations,
submissions, and money exactly as supplied. It must
not run a parallel timer, generate an order, infer a cooking phase, validate a
plate, or calculate score.

## Setup photos and provider seam

- `POST /api/photos`: raw still bytes (`image/jpeg`, `image/png`, or fixture
  `application/octet-stream`) or multipart fields named `photo`/`photos`; up to
  four photos are retained and three makes review-ready.
- `POST /api/floorplan/review`: run the provider and return the reviewable
  four-station plan.
- `POST /api/floorplan/approve` with `{ "approved": true }`: approve it.
- `GET /api/photos` and `GET /api/floorplan`: inspect setup state.

The default provider is a deterministic local roughly 10 m by 10 m fixture with
pantry, fridge, cutting board, and stove. Optional OpenAI image review is
server-side and visibly falls back to the fixture. The simulator needs no cloud
service.

## Laptop serial path and future deployment seam

The current physical integration path connects the host badge to the captain's
laptop. Configure that laptop's serial device path after its USB serial settings
have been established, for example on Linux:

```sh
HTN26_SERIAL_DEVICE=/dev/ttyACM0 node pi/server/server.mjs --host 127.0.0.1 --port 8787
```

Device names and serial configuration are laptop/OS-specific. The adapter opens
the configured device as a byte stream and retries after disconnect. Diagnose
parsing independently with:

```sh
curl -sS -X POST http://127.0.0.1:8787/api/serial \
  -H 'content-type: application/json' \
  -d '{"line":"HTN26|1|GATEWAY|UP|1|0"}'
curl -sS http://127.0.0.1:8787/api/health
```

QNX is only a possible future deployment target for this server. If a future
QNX master adapter is connected, pass it to `createRuntime` as
`authoritativeEngine`; its canonical results/snapshots replace local fixture
submission and badge-event decisions. The current launch and validation path
does not require or claim QNX.

## Validation

```sh
cd pi/server
node --test test/*.test.mjs
```

Tests cover canonical and legacy protocol parsing, chunked/noisy serial input,
deduplication, native `GAME`/fixed-player `E` lifecycle processing, lifecycle
timing and cleanup, natural orders, all four patience states,
expiration/wrong-order penalties, authoritative three-player submissions,
early gold/tips, chopping/cooking, player plates, browser HTML, SSE/JSON
projections, and diagnostic serial injection. They are laptop-hosted simulator
tests only. They do not prove
physical badge/NFC/radio/USB behavior, phone-camera capture, OpenAI
connectivity, or any possible future QNX deployment.

For a temporary Cloudflare tunnel, keep the server bound locally and point
`cloudflared tunnel --url http://127.0.0.1:8787` at it. A tunnel is not an
authentication boundary; use a private access policy before sharing it outside
the trusted demo network, and never put provider or tunnel secrets in browser
JavaScript or query strings.
