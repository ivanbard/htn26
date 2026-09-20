# HTN26 v1 laptop runbook

This guide runs the current room-layout and browser surfaces on a laptop. The
QNX Raspberry Pi remains the target for the authoritative game engine, but its
runtime, device integration, and any difficulty sidecar are future validation,
not prerequisites or claims in this runbook.

The current hackathon setup uses the root `server/` and `ui/` surfaces. Upload 3-5 classroom photos to the server-side OpenAI room-layout endpoint, review the generated proposal, and explicitly approve it. The deterministic floorplan remains available; QNX/on-device inference is future-only.

## Components

- `server/`: Node.js HTTP/SSE and host-badge USB-serial boundary; current laptop/server development surface.
- `ui/`: browser UI with mock and HTTP transports.
- `badge/native/`: pinned low-memory firmware extension used by all four badges.
- `badge/master/`: retained stationary-host Lua rollback profile.
- `badge/slave/`: retained fixed-player Lua rollback profile.

The master-engine contract is authoritative for orders, cooking, scoring,
gold, tips, and submissions. Root `server/` uses its local projection only as a
workstation fixture until that adapter is connected. The host badge owns the
four-minute round lifecycle. Player badges own local interaction feedback and
send intent through the host.

## Hardware

- One laptop with Node.js 20+, a writable application-data directory, and the
  root `server/` and `ui/` checkouts.
- A Raspberry Pi/QNX target only for future integration validation.
- One Hacker Badge for the host/gateway.
- Three Hacker Badges for players 1, 2, and 3.
- One USB data connection from the host badge to the laptop for the current
  serial-adapter path.
- NFC zones for pantry, fridge, cutting board, and stove.
- Apple phone for the 3-5 classroom setup photographs.

The laptop-first room-layout path uses the server-side `OPENAI_API_KEY`; never expose it to browser code. The current v1 still does not use camera tracking or player-location inference, and QNX/on-device AI validation remains future work.

## Badge deployment profile

Use the native profile for the current badges. The Lua host reaches NimBLE with
only 26,124 free bytes / a 15,360-byte largest block and fails with
`ESP_ERR_NO_MEM`; the player independently exceeds available Lua memory. Native
clean-reboot measurements reached radio-ready state and are the evidence-backed
low-memory path.

Flash the pinned candidate to the host and all three players only after following
[`badge/native/README.md`](badge/native/README.md) in full. That gate requires a
fresh per-device backup, read-only security inspection, factory-only write and
readback, and an explicit factory-only rollback. Never erase the device, write
other partitions, alter security configuration, or change eFuses.

Do not mix native and Lua badges. Their OC1 application bytes agree, but Lua's
restricted radio API uses a private `LUA1` carrier wrapper and native mode uses
the recovered HAL directly. The `badge/master/` and `badge/slave/` Lua apps are
retained as a whole-fleet rollback for restored stock factory firmware.

The current native role/payload changes have offline build/emulator coverage,
not physical acceptance. Complete the four-badge hardware gate before calling
the OOM resolved.

For NixOS-WSL, use the interactive backup-first deploy helper from the repository
root:

```sh
python -m pip install pyserial esptool
python badge/native/deploy.py
```

The helper lists every discovered serial port with its description, lets you
choose the port and `host` or `player` role, builds the native image, prints the
read-only security check, saves full/partition/factory backups, requires typing
`FLASH`, writes only the factory partition, and verifies the readback. It never
erases flash or writes the bootloader, partition table, NVS, PHY, or storage.
Backups default to `~/htn26-badge-backups/`. Use `--skip-build` only when the
candidate image has already been built and `--image PATH` to select a specific
candidate. Do not run it until the selected badge is in its established
bootloader mode.

## Laptop server

From the repository root on the laptop:

```sh
cd server

OPENAI_API_KEY=sk-... \
HTN26_BIND_HOST=127.0.0.1 \
HTN26_PORT=8787 \
HTN26_DATA_DIR=./data \
node server.mjs
```

Add `HTN26_SERIAL_DEVICE` with the laptop's readable host-badge device when
testing serial input. If omitted, the server starts without physical serial
input and the diagnostic route remains available. Do not copy this command to
QNX and claim deployment; Node availability, serial enumeration, permissions,
and baud settings still require target validation.

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

- `HTN26_ROUND_SECONDS=240`
- `HTN26_ORDER_INTERVAL_MIN_SECONDS=8`
- `HTN26_ORDER_INTERVAL_MAX_SECONDS=35`
- `HTN26_MAX_ACTIVE_ORDERS=3`
- `OPENAI_API_KEY` is required for active 3-5-photo generation and must remain
  server-only; omit it only for the separate deterministic path.

The server supports four recipes: plain meat, cheeseburger, lettuce-meat, and cheese-lettuce-meat. Every recipe includes meat. Active orders have independent three-segment patience meters.

## UI

The UI development server requires Node.js 20 or newer:

```sh
cd ui
HOST=0.0.0.0 PORT=4173 npm run dev
```

The mock UI is available at:

```text
http://LAPTOP_ADDRESS:4173/
```

The HTTP transport is selected with:

```text
http://LAPTOP_ADDRESS:4173/?transport=http
```

The current UI HTTP transport expects `/api/state`, `/api/command`, and `/api/events` to be same-origin. For integrated testing, place a reverse proxy in front of both processes:

```text
/api/*  -> http://127.0.0.1:8787
/*      -> http://127.0.0.1:4173
```

Then open the proxy address with `?transport=http`, for example:

```text
http://LAPTOP_ADDRESS:8080/?transport=http
```

The UI displays snapshot timer, order patience, player positions when supplied,
holdings, actions, submissions, gold, and tips. Setup photos do not supply live
player tracking; absent positions remain absent. The UI never independently
scores plates.

## Host badge selection

After the native backup/factory-only flash/readback gate, boot the gateway,
open **Overcooked**, and press START once to select host mode. Leave it in the
foreground and connect its USB data cable to the laptop. Host mode starts the radio
without NFC and logs `HTN26|GW|UP|0|0` on success; stop on `GW|DOWN` rather than
starting a round.

The host badge logs:

```text
HTN26|GAME|START_GAME|240|3
HTN26|GAME|GAME_END|3
```

It forwards player radio events as records beginning with `HTN26|RX|...`. The
root server parser searches for that marker anywhere in a serial line because
badge runtime logs may add prefix text.

## Player badge selection

After applying and verifying the same native candidate on each player badge:

1. Open **Overcooked** and press A for player mode.
2. Use LEFT/RIGHT to select one unique number 1, 2, or 3.
3. Press A again to confirm and start native radio plus NFC.
4. Keep Overcooked in the foreground during the round.

Native selection is per app boot; repeat it after reopening. There are exactly
three fixed players and no late joins. For rollback, restore the pre-write
factory partition on all four badges, then follow `badge/master/README.md` and
`badge/slave/README.md` to select the retained Lua apps.

Player controls include NFC ingredient pickup, cutting, cooking, plate
assembly, badge-to-badge transfer, dropping, and simultaneous-shake
submission. The player app communicates only through the host/gateway badge,
not directly with the laptop server or future Pi master.

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

## Laptop-first room-layout run

1. Start root `server/` on the laptop with `OPENAI_API_KEY` set only in its
   environment.
2. Start root `ui/` and open the HTTP transport through the same-origin proxy.
3. Start host mode, choose 3-5 overlapping classroom photos, and submit them
   once. The browser performs orientation-aware parallel resize/compression.
4. Review the complete proposed presentation area, objects, play area, and
   four stations. A new generation replaces the unaccepted proposal.
5. Explicitly approve the proposal, then place the pantry, fridge, cutting
   board, and stove NFC zones. `START_GAME` stays unavailable before approval.
6. Connect the host badge if exercising laptop serial input, select unique
   player numbers on all three badges, and start the round.
7. Confirm lifecycle, orders, patience, players, stations, submissions, gold,
   tips, and safe end/reset behavior in the snapshot and UI.

The equivalent direct API request sends all photos in one multipart upload:

```sh
curl -X POST http://127.0.0.1:8787/api/layout/generate \
  -F 'photos=@room-front.jpg' \
  -F 'photos=@room-left.jpg' \
  -F 'photos=@room-right.jpg'
```

Never put `OPENAI_API_KEY` in Lua, browser JavaScript, a URL, or this
repository. Generation stores an unaccepted proposal and returns safe generic
failures. Audit request/folder IDs are returned in headers.

For an offline deterministic review, keep the path explicit and separate:

```sh
curl -sS -X POST http://127.0.0.1:8787/api/floorplan/review \
  -H 'content-type: application/json' \
  -d '{"allowEmpty":true}'
curl -sS -X POST http://127.0.0.1:8787/api/floorplan/approve \
  -H 'content-type: application/json' \
  -d '{"approved":true}'
```

## Future QNX boundary

Do not move the root server back under `pi/`. A future QNX adapter may supply
authoritative master snapshots and a future difficulty director may return
bounded recommendations, but neither may duplicate game rules or own the
photo/layout API. No host-side check here proves QNX serial, OpenAI, camera,
difficulty-sidecar, or physical classroom behavior.

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
(cd server && node --test test/*.test.mjs)

python -m pip install --target .tools/python lupa==2.8
python -m unittest discover -s badge/master/tests -p 'test_*.py' -v
python -m unittest discover -s badge/slave/tests -p 'test_*.py' -v

python badge/native/build.py
python badge/native/test_build.py
python badge/native/test_payload.py
python badge/native/ble_receiver.py --self-test

(cd ui && npm test)
```

The native build requires the pinned Zig 0.14.1 compiler and the payload test's
Unicorn dependency as documented in its README. These tests do not prove the
OOM fixed on-device, QNX serial enumeration, physical NFC, four-badge radio and
ACK behavior, LED appearance, timing, stock-app regressions, phone capture, or
OpenAI connectivity. Perform the native physical acceptance gate and then the
first playable run.
