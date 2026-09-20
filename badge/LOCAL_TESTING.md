# Local badge testing

The current fixed player app is tested by the focused production-helper suite
documented in [`slave/README.md`](slave/README.md). The older local gameplay
runner below remains a legacy compatibility slice; it is not the current
player-badge contract.

Run from the repository root:

```powershell
python -m pip install --target .tools/python lupa==2.8
python badge/run_local.py
powershell -ExecutionPolicy Bypass -File badge/check-overcooked.ps1
python -m unittest discover -s badge/master/tests -v
python -m unittest discover -s badge/slave/tests -v
```

The legacy `run_local.py` executes Lua apps in independent environments sharing
`local_transport.lua`. NFC card/text, clock, screen, LEDs, sensors, and storage
are host fakes. The local bus is also injected as the documented `badge.radio`
endpoint for the self-contained player app, so transport messages invoke the
apps' actual registered receive handlers without starting BLE. Normal ticks
drain the existing queues and run the real host state transitions.

Its scripted game scans `I:TOM`, places it on `P:01`, and submits that plate at
the serving app. It checks `GAME|PLATE_ADD|01|TOM`, `GAME|SUBMIT|01|OK`, and
`GAME|SCORE|10`. A second plate reaches 20 points. It also checks invalid tags,
empty hands, full hands, occupied plates, empty submissions, identity targeting,
NFC debounce, a lost acknowledgement, exact-packet bounded retries, no duplicate
score/logs, missing host, exit cleanup, and the radio adapter contract.

## Legacy transport boundary

The legacy gateway/serve slices load `require("transport")`; the current
self-contained player app calls the documented `badge.radio` API directly. Both
paths use the same contract: `enable()`, `disable()`, `on_recv(handler)`,
`send(payload)`, `mac()`, and `dropped()`. The receive handler takes
`(sender_mac, rssi, payload)`. Sending succeeds only for 1–44 bytes and does
not imply host acceptance.

The local runner injects a bus endpoint for each app. The badge deployment
module `transport.lua` selects `radio_transport.lua` with its enable flag set
to **true**, allowing the host badge to broadcast lifecycle controls and
forward player events. Hardware startup, timing, radio range, and real NFC
remain unverified.

The self-contained player upload does not use these legacy transport modules.
For legacy `overcooked-*.lua` uploads, put `transport.lua` and
`radio_transport.lua` beside `main.lua` using the IDE's extra-file support.
Do not upload the desktop runner, local bus, or tests. The standalone radio
probe is diagnostic only.

## Legacy reviewed components

PRs #1–#5 add the camera worker, stationary gateway, player, UI, and Pi core.
The gateway and player now use the same transport boundary. Their separate
local test executes production NFC polling and gateway serial logging, including
three identical retries and gateway-owned plate submission.

These historical slices are retained for compatibility and are not the
current fixed player flow:

| Path | Protocol/state owner | Verified scope |
| --- | --- | --- |
| Three-app MVP | Type-first OC1; Lua host owns plates and score | Complete raw-tomato slice through `GAME` logs |
| PR player/gateway | Sequence-first OC1; gateway emits `HTN26` logs | NFC actions, forwarding, serving plate logs |
| Pi engine | Sequence-first OC1; C++ owns tomato-soup state | Standalone core tests, timers, tracking, delivery, score |
| UI | Snapshot/command transport; default fixture | Offline burger setup/rendering tests |

The Pi core still needs the gateway `HTN26|PLATE|P:nn` path connected to physical
plate ownership, player chopping input connected to its `M|CHOP` action, worker
telemetry type adapters, and a UI state/command adapter. Its test delivery intent
does not authorize adding delivery to the player badge. Those are pre-existing
integration gaps, not reasons to rewrite the current game for the radio failure.

Review fixes: gateway targeted-reply parsing now matches its tests; player
delivery-tag emission was removed to preserve stationary submission ownership;
NFC rearm no longer discards a different tag arriving at the rearm deadline;
unconfigured workers cannot enroll themselves in the Pi engine. Gateway tests
now run Lua instead of skipping, and player helper tests execute production Lua
instead of a Python reimplementation.
