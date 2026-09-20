# HTN26 v1 Deployment

This guide deploys the current one-Pi burger game: one QNX Raspberry Pi, one host badge, and three fixed player badges.

The current hackathon setup uses the root `server/` and `ui/` surfaces. Upload 3-5 classroom photos to the server-side OpenAI room-layout endpoint, review the generated proposal, and explicitly approve it. The deterministic floorplan remains available; QNX/on-device inference is future-only.

## Components

- `server/`: Node.js HTTP/SSE and host-badge USB-serial boundary; current laptop/server development surface.
- `ui/`: browser UI with mock and HTTP transports.
- `badge/native/`: pinned low-memory firmware extension used by all four badges.
- `badge/master/`: retained stationary-host Lua rollback profile.
- `badge/slave/`: retained fixed-player Lua rollback profile.

The Pi is authoritative for orders, cooking, scoring, gold, tips, and submissions. The host badge owns the four-minute round lifecycle. Player badges own local interaction feedback and send intent through the host.

## Hardware

- One QNX Raspberry Pi with a writable application-data directory.
- One Hacker Badge for the host/gateway.
- Three Hacker Badges for players 1, 2, and 3.
- One USB data connection from the host badge to the Pi.
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

## Root server

The QNX image must provide Node.js 20 or newer, or an equivalent supported Node runtime. QNX serial-device enumeration, permissions, baud settings, and Node availability remain target-hardware validation items.

From the repository root on the Pi:

```sh
cd htn26/server

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

- `HTN26_ROUND_SECONDS=240`
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

## Host badge selection

After the native backup/factory-only flash/readback gate, boot the gateway,
open **Overcooked**, and press START once to select host mode. Leave it in the
foreground and connect its USB data cable to the Pi. Host mode starts the radio
without NFC and logs `HTN26|GW|UP|0|0` on success; stop on `GW|DOWN` rather than
starting a round.

The host badge logs:

```text
HTN26|GAME|START_GAME|240|3
HTN26|GAME|GAME_END|3
```

It forwards player radio events as records beginning with `HTN26|RX|...`. The Pi should search for that marker anywhere in a serial line because badge runtime logs may add prefix text.

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
3. Connect the host badge, open Overcooked, and select host mode.
4. Open Overcooked on all three player badges and confirm unique player numbers.
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

For laptop room-layout generation, set `OPENAI_API_KEY` only in the root server environment. Never put it in Lua, browser JavaScript, a URL, or this repository. The deterministic floorplan remains available when generation is unavailable.

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
