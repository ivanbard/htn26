# Gateway badge guidance

The host implementation contract is [`README.md`](README.md).

The badge API boundary is [`../badge-app-guide.md`](../badge-app-guide.md), and
product decisions are in [`../../README.md`](../../README.md) and
[`../../updates/UPDATE_v1.1.md`](../../updates/UPDATE_v1.1.md).

Keep this subtree responsible for the stationary host's 240-second lifecycle,
three-player session reset, restricted-radio receive gateway, bounded queue,
serial framing, and local status UI. The laptop server remains authoritative
for the game countdown and processing of player intent, inventory, orders,
scoring, and resulting game state.

Use only APIs documented by the badge guide. Do not add serial input, network,
camera, arbitrary BLE/GATT, server-to-badge, multi-Pi, or live-camera behavior.
Keep the host app self-contained; do not reintroduce transport modules as an
installation dependency.

Run the focused host checks from the repository root:

```sh
python -m unittest discover -s badge/master/tests -p 'test_*.py' -v
```

These are host-side checks only. Physical radio, USB serial, and timer
validation require the connected hardware workflow in `README.md`; they do not
claim QNX validation.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
