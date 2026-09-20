# Burger Level UI

This directory contains the current laptop-hosted HTN26 browser UI. Its React
surface can use the offline mock or the root `server/` HTTP/SSE transport. The
server remains authoritative for photos, layouts, and game state.

## Run locally

Requires Node.js 20 or newer.

```sh
cd ui
npm test
npm run dev:live
```

`npm run build` creates the production bundle in `dist/`.

Open <http://127.0.0.1:4173>. The browser defaults to the live HTTP/SSE
transport; use `?transport=mock` for the offline fixture. Vite proxies
same-origin `/api` requests to `http://127.0.0.1:8787` by default. Override that
target with `HTN26_API_PROXY_TARGET` when necessary.

Open <http://127.0.0.1:4173/photos> on the phone for the minimal setup-photo
page. Selecting 4-5 same-room images immediately sends one request to
`POST /api/layout/generate`; this route does not render the game UI.

Try the prototype host flow:

1. `Start` host mode.
2. Continue with the normal layout (the mock has no remote photo upload to wait for).
3. Follow the floor-focused tour to place the cheese, lettuce, meat, and bun sources, the chopping boards, stoves, and assembly counter as shown.
4. `Start Game` for a four-minute round.

The mock also supports delivery fixtures for tests (`DELIVERY_SUCCESS` and `DELIVERY_FAILURE`). The UI renders the serving result and score supplied by the transport; it does not create a delivery result itself.

## Prototype flow

The transport remains authoritative. This prototype mirrors the following
fixture flow; it is not the current laptop simulator's run path:

```text
host Start
  -> camera room scan
  -> personalized floor layout, or normal layout fallback
  -> burger level placement instructions
  -> four-minute burger round
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

- `src/mock-transport.js` is the required offline development transport. It owns a fixture state and applies host commands as a stand-in for an authoritative server. While a round runs it also ticks every second (`advanceMockState`, mirroring `pi/server/src/projection.mjs`): the four-minute (240 s) round clock, order patience, order spawning (one order at round start, then a random 8-35 s gap, at most three open, never zero; the mock's own patience is 60 s plus 15 s per topping), chop progress, and the stove cooking -> done -> warning -> burnt timeline. This is the only place timers advance; the renderer only displays the snapshot values.
- Station progress bars appear only on stoves and chopping boards that hold an item or are cooking/chopping/done/burnt. Runtime stations are paired with plan stations by id first, then by kind, because the Pi's plan has one `stove` while its runtime stations are `stove-left`/`stove-right`.
- `src/transport.js` includes a local HTTP/SSE transport for integration with an authoritative server. It expects `GET /api/state`, `POST /api/command`, and `GET /api/events`.
- The browser defaults to the HTTP seam so the deployed desktop and phone share the root server; use `?transport=mock` only for the offline fixture. It uses same-origin `/api` routes so the Vite proxy also works for LAN clients; an explicit `api`/`apiBase` query value can override it. A supplied `window.__HTN26_TRANSPORT__` takes precedence for integration tests.
- `src/PhotosPage.js` owns the isolated `/photos` upload surface and posts each 4-5 image selection directly to the server layout-generation route.
- `src/App.js` contains the React component tree for the staged setup flow, framed room board, order HUD, player/station overlays, and live notifications.
- `src/render.js` renders the same React tree to static markup for contract tests. It does not create timers, move players, score deliveries, or infer station/order state.
- The gameplay display includes the Figma-derived order queue, goose-coin score rail, and round timer. Up to four cards come from `orders`; `order` remains the legacy primary-order fallback. The timer is redrawn from authoritative `clock` snapshots and is never decremented by the browser.
- `assets/` contains the downloaded Figma stopwatch SVGs, the current badge ingredient PNGs, and the gameplay room background used behind the accepted room mirror. Higher-quality ingredient illustrations or a revised room background can replace those files without changing the HUD markup or state contract.

The renderer uses three display modes so setup controls do not compete with the live game display:

- `setup`: host controls, the room mirror, and physical burger-level placement instructions.
- `gameplay`: one framed room board with up to four active orders across the top, the score at bottom-left, the round clock at bottom-right, live tracked players, and one compact announcement pill centred between the score and the clock (styled like them, sentence case, always naming the WatCoins gained or lost, with a served burger's tip as a smaller second figure: "Burger served +100 WatCoins +20 tip", "Wrong burger -25 WatCoins", "Order expired -20 WatCoins"). Its zone is exactly the gap between the score and the clock and it scales with the board, so it cannot overlap them; the tip drops out first on a very small board. Operator health chrome is intentionally excluded from the player-facing HUD.
- `results`: the completed round, score, serving result, and final room mirror.

The frontend snapshot boundary is defined in `src/contracts.js` (version 2). Optional `orders` may retain completed history but must contain no more than four active objects, all with unique, non-empty IDs; snapshots without it continue to render the required legacy `order`. `floorPlan.coordinateSpace` must be `normalized-percent`; its `width` and `height` are positive finite values, and wall/station `x`, `y`, `width`, and `height` values are normalized to the 0–100 range. Present player positions use the same 0–100 coordinate space; a missing position is allowed so the UI can explicitly show tracking lost. A future camera-enabled adapter would be responsible for projecting room-camera coordinates into this display space before sending a snapshot. Invalid snapshots render an error state instead of partially rendering authoritative data.

Authoritative values stay explicit:

- `floorPlan.accepted`, `floorPlan.stations`, and `burgerLevel.placementInstructions` describe the accepted map and where the physical burger level belongs.
- `players[].position` and `players[].tracking.lastSeenAt` are optional transport observations for this prototype. The current v1 laptop simulator does not supply camera-tracked player positions. Missing players are rendered at no fabricated location; stale health remains available through accessible labels without adding large warning boxes to the game board. Player tokens never animate between snapshots.
- `orders[].remainingSeconds`, `order.remainingSeconds`, `clock.remainingSeconds`, station `progress`, and cooking state are displayed values from the authoritative snapshot. The UI never decrements them locally.
- `health.gateway`, `health.workers`, and `health.inference` remain available to the host integration, but system-health warnings are intentionally excluded from the player-facing gameplay HUD.
- `stations[].item`, `stations[].status`, and `stations[].remainingSeconds` are rendered directly on their physical boards or plates. Empty stations explicitly show `EMPTY`; the player-facing screen has no separate live-activity feed.
- `serving.lastEvent` remains available to results/integration surfaces, while `score` is rendered exactly as delivered by the transport.

## Fixture simulator (opt-in)

`npm run dev` is also hardware-safe, but use `npm run dev:live` for a live
presentation because it explicitly forces fixture simulation off. Neither
command starts scripts or sends fake player events. The server therefore waits
for the host badge's real `START_GAME|240|<1-3>` record and displays the full
four-minute round.

Use `npm run dev:simulate` only when deliberately watching the frontend without
a phone or badges. It enables `dev-simulator.mjs`, which runs Ethan's two
fixture scripts, `server/simulate-photos.mjs` then `server/simulate-game.mjs`,
after setup starts. It only polls `/api/state` on the server the `/api` proxy
targets (`HTN26_API_PROXY_TARGET`, default `http://127.0.0.1:8787`) and runs
the existing scripts; it changes nothing outside `ui/`.

- It fires when the setup phase moves from `idle` (or `ended`) to `scanning`, which is the operator pressing Get Started. The scripts send `START_HOST` themselves, so a run blocks re-triggering until it finishes; it re-arms once the game is back at rest.
- If a script exits with an error the next one still runs (the photo script fails on a repeat game because the server keeps and caps earlier photos; the game script does its own setup). A game already in progress when the dev server starts is left alone. Output appears in the dev-server console prefixed `[sim]`.
- The fixture game intentionally ends early after showing a success and a
  failure result. Never use it around live badges; stop it with Ctrl-C and
  restart with `npm run dev:live`. It needs the game server running and waits
  quietly until the server answers.

## Never stranded

Every screen in the setup-to-play flow has a working way forward or back, whatever fails (`test/no-dead-ends.test.js`, `test/connection-resilience.test.js`):

- **No server yet, or it dies later:** the page keeps retrying; "Try again now", "Reload the page" and "Open the offline demo" are on the waiting screen. If the connection drops after it was working, a banner says so and the last screen stays up; it clears when the server answers again. A quiet or broken event stream is backed by a 5 s check of `/api/state`.
- **State it cannot read** (for example a phase it has never heard of) or a **render error** shows what happened with Reload / Reset the game instead of a dead end or a blank page; the error screen clears itself when a newer snapshot arrives.
- **Player setup:** with no badges connected the normal buttons stay disabled, but "Continue anyway" is always available (the round starts from the host badge, which does not require the badges to have connected first). If the personalized layout fails, the normal layout is offered first and "Try the personalized layout again" stays available.
- **Tour:** the card can never hide its own buttons. A step with no target, a board that cannot be measured, or a measurement that throws all show the card centred; a second "Skip tour" button lives outside the card while it is not yet showing and on very short windows.
- **Failed commands** show the server's reason when it gives one and can be dismissed; a failure that lands after the game already moved on (a double click) is not reported. The waiting-for-host screen explains a long wait and always keeps "Cancel and reset".
- **Phone photos page:** after a failed upload the same photos can be chosen again.

## Server not running

If the browser shows "GAME SERVER UNAVAILABLE", the game server is not reachable (through the dev proxy that appears as a 5xx). Start it with `node server/server.mjs --serial DEVICE`, replacing `DEVICE` with the host badge's USB serial path; the page retries every 3 s and recovers on its own without a reload. The server intentionally does not attach to a badge unless `--serial` is supplied.

## Tests

```sh
npm test
```

Tests use only Node's standard library and cover the setup/gameplay/results display modes, aligned station and placement data, missing/stale tracking, stale worker health, invalid normalized coordinates, host scan/approval/start/end/reset transitions, invalid actions, duplicate deliveries, and serving/score success and failure updates.
