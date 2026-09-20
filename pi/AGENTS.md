# Raspberry Pi component guidance

Read [`../README.md`](../README.md), [`../updates/UPDATE_v1.md`](../updates/UPDATE_v1.md), [`../updates/UPDATE_v1.1.md`](../updates/UPDATE_v1.1.md), and [`../FLOW.md`](../FLOW.md) before changing Pi behavior.

Use [`README.md`](README.md), [`master/README.md`](master/README.md), and [`slave/README.md`](slave/README.md) as the implementation owners for the Pi components.

The current v1 deployment runs the authoritative server and UI on the
captain's laptop, with phone photographs used only for setup inference. QNX,
Pi-hosted execution, portable-engine integration, and multi-camera workers are
possible future boundaries.

Keep current authoritative game state, timers, order evaluation, and submission
decisions in `server/`. Treat `master/` as a future portable engine unless the
product contract explicitly adopts it.

Keep camera, inference, and worker code behind the adapter seams owned by the relevant Pi README.

Do not add cloud dependencies or let worker telemetry mutate game state directly.

Run the master and worker validation commands documented by their nearest README after changes.

Host-side tests do not prove QNX, AI-module qualification, phone-camera, or deployed hardware behavior.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
