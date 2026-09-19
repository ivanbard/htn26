# HTN26 v1 Deployment

This guide deploys the current one-Pi burger game: one QNX Raspberry Pi, one host badge, and three fixed player badges.

The first playable setup uses the deterministic static floorplan. Phone photos and AI floorplan generation are optional follow-up features.

## Components

- `pi/server/`: Node.js HTTP/SSE and host-badge USB-serial boundary.
- `ui/`: browser UI with mock and HTTP transports.
- `badge/master/`: stationary host badge and radio gateway.
- `badge/slave/`: fixed player badge app, installed on three badges.

The Pi is authoritative for orders, cooking, scoring, gold, tips, and submissions. The host badge owns the two-minute round lifecycle. Player badges own local interaction feedback and send intent through the host.

## Hardware

- One QNX Raspberry Pi with a writable application-data directory.
- One Hacker Badge for the host/gateway.
- Three Hacker Badges for players 1, 2, and 3.
- One USB data connection from the host badge to the Pi.
- NFC zones for pantry, fridge, cutting board, and stove.
- Optional Apple phone for future setup photographs.

The current v1 does not require cloud services, camera tracking, or player-location inference.

## Pi server

The QNX image must provide Node.js 20 or newer, or an equivalent supported Node runtime. QNX serial-device enumeration, permissions, baud settings, and Node availability remain target-hardware validation items.

From the repository root on the Pi:

```sh
cd htn26/pi/server

HTN26_BIND_HOST=0.0.0.0 \
HTN26_PORT=8787 \
HTN26_DATA_DIR=/var/lib/htn26 \
HTN26_SERIAL_DEVICE=/dev/ser1 \
node server.mjs
```

The serial device is board-specific. Replace `/dev/ser1` with the readable QNX serial device for the host badge. If the serial path is omitted, the server starts without physical serial input and can be tested with the diagnostic route.

Health check:

```sh
curl http://127.0.0.1:8787/api/health
```

Diagnostic serial check:

```sh
curl -sS -X POST http://127.0.0.1:8787/api/serial \
  -H 'content-type: application/json' \
  -d '{"line":"noise HTN26|GW|UP|1|0"}'
```

Useful settings:

- `HTN26_ROUND_SECONDS=120`
- `HTN26_ORDER_INTERVAL_MIN_SECONDS=8`
- `HTN26_ORDER_INTERVAL_MAX_SECONDS=35`
- `HTN26_MAX_ACTIVE_ORDERS=3`
- `OPENAI_API_KEY` is optional and must remain server-only.

The server supports four recipes: plain meat, cheeseburger, lettuce-meat, and cheese-lettuce-meat. Every recipe includes meat. Active orders have independent three-segment patience meters.

## UI

The UI development server requires Node.js 20 or newer:

```sh
cd htn26/ui
HOST=0.0.0.0 PORT=4173 npm run dev
```

The mock UI is available at:

```text
http://PI_ADDRESS:4173/
```

The HTTP transport is selected with:

```text
http://PI_ADDRESS:4173/?transport=http
```

The current UI HTTP transport expects `/api/state`, `/api/command`, and `/api/events` to be same-origin. For integrated testing, place a reverse proxy in front of both processes:

```text
/api/*  -> http://127.0.0.1:8787
/*      -> http://127.0.0.1:4173
```

Then open the proxy address with `?transport=http`, for example:

```text
http://PI_ADDRESS:8080/?transport=http
```

The UI displays authoritative timer, order patience, players, holdings, actions, submissions, gold, and tips. It does not move player icons from camera data or independently score plates.

## Host badge installation

Install exactly these files from the Badge IDE:

```text
badge/master/manifest.cfg
badge/master/main.lua
```

If the IDE has **Import app**, import the complete app package and choose **Replace editor files**. Otherwise, copy `manifest.cfg` and `main.lua` into the two matching editor files.

Then:

1. Save any existing badge app.
2. Turn the badge off.
3. Connect a USB data cable.
4. Turn it on normally without holding START.
5. Choose **USB JTAG/serial debug unit (Espressif)**.
6. Click **Push**.
7. Open **HTN26 Host** and leave it in the foreground.
8. Connect the host badge USB cable to the Pi.

The host badge logs:

```text
HTN26|GAME|START_GAME|120|3
HTN26|GAME|GAME_END|3
```

It forwards player radio events as records beginning with `HTN26|RX|...`. The Pi should search for that marker anywhere in a serial line because badge runtime logs may add prefix text.

## Player badge installation

Install the same two files on each player badge:

```text
badge/slave/manifest.cfg
badge/slave/main.lua
```

For each badge:

1. Push the player app using the same IDE procedure.
2. Open it from the launcher.
3. Use LEFT/RIGHT to select player 1, 2, or 3.
4. Press A to save the assignment.
5. Keep the player app in the foreground during the round.

There are exactly three fixed players and no late joins.

Player controls include NFC ingredient pickup, cutting, cooking, plate assembly, badge-to-badge transfer, dropping, and simultaneous-shake submission. The player app does not communicate directly with the Pi.

## Physical burger setup

Place four NFC zones:

- Pantry: buns and lettuce.
- Fridge: cheese and raw meat.
- Cutting board: cut meat, cheese, and lettuce.
- Stove: cook cut meat.

Burger flow:

```text
meat -> cut -> cook
cheese -> cut
lettuce -> cut
buns -> plate
all required ingredients -> submit
```

Cooking takes 15 seconds, followed by the documented done, warning, and burnt states.

## First playable run

1. Start the Pi server.
2. Start the UI or reverse proxy.
3. Connect the host badge and open its host app.
4. Open the player app on all three player badges.
5. Review and approve the static four-station floorplan.
6. Press START on the host badge.
7. Test ingredient pickup, chopping, cooking, plate assembly, transfers, and simultaneous submission.
8. Confirm host serial records arrive at `/api/health` and the UI.
9. Confirm orders, patience, gold, tips, and submission results.
10. Wait for GAME_END and confirm round state is cleared.

## Optional phone photos and AI

The first playable run should use the static floorplan. The server has an optional photo/provider seam:

```sh
curl -X POST http://PI_ADDRESS:8787/api/photos \
  -H 'content-type: image/jpeg' \
  --data-binary @room.jpg
```

If OpenAI setup inference is later enabled, set `OPENAI_API_KEY` only in the Pi server environment. Never put it in Lua, browser JavaScript, a URL, or this repository. The local fixture remains the fallback for missing or failed provider responses.

## Optional Cloudflare Tunnel

Cloudflare is not required for local play. Do not expose the unauthenticated server publicly.

For a temporary tunnel to a reverse proxy listening on port 8080:

```sh
cloudflared tunnel --url http://127.0.0.1:8080
```

For a named tunnel, create `~/.cloudflared/config.yml`:

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /etc/cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: game.example.com
    path: /api/.*
    service: http://127.0.0.1:8787
  - hostname: game.example.com
    service: http://127.0.0.1:4173
  - service: http_status:404
```

Authenticate and run it with the normal Cloudflare flow:

```sh
cloudflared tunnel login
cloudflared tunnel run YOUR_TUNNEL_NAME
```

Protect the hostname with Cloudflare Access before sharing it outside the trusted demo network. Tunnel tokens, credentials, and API keys must stay outside Git and browser code.

## Host-side validation

From the repository root:

```sh
cd pi/server
node --test test/*.test.mjs

cd ../../badge
python -m pip install --target .tools/python lupa==2.8
python -m unittest discover -s master/tests -p 'test_*.py' -v
python -m unittest discover -s slave/tests -p 'test_*.py' -v

cd ../ui
npm test
```

These tests do not prove QNX serial enumeration, physical NFC, radio range, LED appearance, badge firmware behavior, phone capture, or OpenAI connectivity. Perform those checks during the first physical run.
