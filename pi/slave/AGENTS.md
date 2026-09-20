# Camera worker guidance

The worker contract, adapter seams, and validation scope are [`README.md`](README.md).

Read [`../README.md`](../README.md), [`../../README.md`](../../README.md), and [`../../FLOW.md`](../../FLOW.md) before changing worker behavior.

Keep this subtree responsible for local camera and inference adapters, calibration, tracking observations, health, and bounded telemetry.

Workers never own authoritative game state, badge events, orders, or scoring.

Do not claim live player tracking for the current v1 product unless the product brief is explicitly expanded beyond setup photographs.

Run the documented CMake and CTest commands from [`README.md`](README.md) after worker changes.

The demo and host tests do not prove QNX camera, AI, network, or deployment behavior.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
