# HTN26 v1 laptop deployment

This guide deploys the current laptop-hosted burger game: the captain's laptop,
one host badge, and three fixed player badges. QNX and Raspberry Pi hosting of
the authoritative server remain possible future targets. An optional QNX Pi
may instead host the label-only difficulty sidecar documented in
[`pi/difficulty/README.md`](pi/difficulty/README.md); it is not required for the
current run, and this revision does not claim QNX validation.

The current setup uploads Apple-phone still photographs to the laptop server.
The local deterministic floorplan provider remains available as the no-cloud
fallback.

## Components

- `pi/server/`: Node.js game simulator, plain browser view, HTTP/SSE API, and
  host-badge USB-serial boundary.
- `pi/difficulty/`: optional QNX difficulty sidecar; its owning README defines
  the label-only contract and QNX deployment assumptions.
- `ui/`: separate styled UI prototype; it is not the current plain simulator
  page.
- `badge/native/`: production/live pinned firmware extension used by all four badges.
- `badge/master/`: retained stationary-host Lua rollback profile.
- `badge/slave/`: retained fixed-player Lua rollback profile.

The laptop server is authoritative for round state and countdown, orders,
cooking, scoring, gold, tips, and submissions. The host badge initiates the
physical lifecycle, displays its local countdown, and emits start/end records.
Player badges own local interaction feedback and send intent through the host.

## Hardware

- The captain's laptop with Node.js 20 or newer and a writable application-data directory.
- One Hacker Badge for the host/gateway.
- Three Hacker Badges for players 1, 2, and 3.
- One USB data connection from the host badge to the laptop.
- NFC zones for pantry, fridge, cutting board, and stove.
- One Apple phone for setup photographs.

The current v1 does not require cloud services or camera/live player-location
tracking. The server and UI use badge events to infer simulated station or
center/default occupancy; a paired bump displays both participants side by
side at the shared center. These cues are neither physical-position evidence
nor physical bump validation.

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

Preserve this order separately for every badge:

1. Before any mutation, complete the read-only security inspection and fresh
   full-device, partition-table, and factory backups in the native guide.
   Verify and preserve those original files off the badge.
2. Boot the unchanged stock firmware, push the current `badge/master/` rollback
   app to the host or the current `badge/slave/` rollback app to each player,
   and verify the matching OC2 app on all four badges.
3. Return each badge to bootloader mode, write only the pinned native factory
   candidate, and verify its factory readback as documented.

The checked-in rollback apps remain in LittleFS across the factory-only write.
The laptop parser intentionally rejects OC1, so do not flash over badges whose
retained rollback apps have not been refreshed as the matching whole-fleet set.

Do not mix native and Lua badges. Their OC2 application bytes agree, but Lua's
restricted radio API uses a private `LUA1` carrier wrapper and native mode uses
the recovered HAL directly. The `badge/master/` and `badge/slave/` Lua apps are
retained as a whole-fleet rollback for restored stock factory firmware.

The captain reports the native game binary working on physical badges except
that bumping two badges together remains unverified. The generated-icon display
revision has offline build/emulator coverage only and still needs a physical
visual check; offline tests do not establish bump or display acceptance.

For NixOS-WSL, use the interactive backup-first deploy helper from the repository
root after the original pre-mutation backup and OC2 rollback installation above:

```sh
python -m pip install pyserial esptool
python badge/native/deploy.py
```

The helper lists every discovered serial port with its description, lets you
choose the port and `host` or `player` role, builds the native image, repeats the
read-only security check, saves an additional post-LittleFS
full/partition/factory backup, requires typing `FLASH`, writes only the factory
partition, and verifies the readback. Its additional backup does not replace
the preserved pre-mutation backup. It never erases flash or writes the
bootloader, partition table, NVS, PHY, or storage.
Backups default to `~/htn26-badge-backups/`. Use `--skip-build` only when the
candidate image has already been built and `--image PATH` to select a specific
candidate. Do not run it until the selected badge is in its established
bootloader mode.

## Laptop server and plain UI

Run `pi/server/server.mjs` on the captain's laptop and open its root URL. The
authoritative run command, serial-device settings, canonical development
protocol, HTTP routes, and environment variables are owned by
[`pi/server/README.md`](pi/server/README.md); this deployment guide does not
duplicate them.

The current page is served by that same process. It is deliberately plain,
uses no CSS or frontend framework, and renders server JSON/SSE snapshots without
running game rules. The separate React app in `ui/` remains an offline design
prototype and is not required for the first functional simulator.

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
laptop server searches for that marker anywhere in a serial line because badge
runtime logs may add prefix text.

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

Player controls include NFC ingredient pickup, cutting, cooking, plate assembly,
badge-to-badge transfer, dropping, and simultaneous-shake submission. The
player app does not communicate directly with the laptop server.

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

1. Start the laptop server.
2. Open the plain browser view served by that process.
3. Connect the host badge, open Overcooked, and select host mode.
4. Open Overcooked on all three player badges and confirm unique player numbers.
5. Upload the phone photographs, then review and approve the proposed four-station floorplan.
6. Press START on the host badge.
7. Test ingredient pickup, chopping, cooking, plate assembly, transfers, and simultaneous submission.
8. Confirm host serial records arrive at `/api/health` and the UI.
9. Confirm orders, patience, gold, tips, and submission results.
10. Wait for GAME_END and confirm round state is cleared.

## Setup photos and optional provider

Upload the setup photographs through the server. The endpoint and provider seam
are documented in [`pi/server/README.md`](pi/server/README.md).

```sh
curl -X POST http://127.0.0.1:8787/api/photos \
  -H 'content-type: image/jpeg' \
  --data-binary @room.jpg
```

If OpenAI setup inference is enabled, set `OPENAI_API_KEY` only in the laptop
server environment. Never put it in Lua, browser JavaScript, a URL, or this
repository. The local fixture remains the fallback for missing or failed
provider responses.

## Optional Cloudflare Tunnel

Cloudflare is not required for local play. Do not expose the unauthenticated server publicly.

For a temporary tunnel to the locally bound server:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

For a named tunnel, create `~/.cloudflared/config.yml`:

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /etc/cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: game.example.com
    service: http://127.0.0.1:8787
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
(cd pi/server && node --test test/*.test.mjs)

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
OOM fix on-device, physical NFC, badge-to-badge bump behavior, generated-icon
appearance, four-badge radio and ACK behavior, LED appearance, timing,
stock-app regressions, phone capture, OpenAI connectivity, QNX sidecar
deployment, or any future authoritative-server deployment on QNX. Perform the
native physical acceptance gate and then the first playable run.
