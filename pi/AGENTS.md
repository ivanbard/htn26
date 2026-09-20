# Raspberry Pi component guidance

Read [`../README.md`](../README.md), [`../updates/UPDATE_v1.md`](../updates/UPDATE_v1.md), [`../updates/UPDATE_v1.1.md`](../updates/UPDATE_v1.1.md), and [`../FLOW.md`](../FLOW.md) before changing Pi behavior.

Use [`README.md`](README.md), [`master/README.md`](master/README.md), and [`slave/README.md`](slave/README.md) as the implementation owners for the Pi components.

The current development flow sends phone setup photos to root `server/` on the
laptop. Pi-side setup inference, multi-camera tracking, and a QNX difficulty
sidecar are future boundaries, not current validated behavior.

Keep authoritative game state, timers, order evaluation, and submission decisions in the master Pi.

A future difficulty sidecar may recommend bounded adjustments through an
adapter but must not duplicate rules, mutate authoritative state directly, or
own HTTP/photo/layout routes.

Keep camera, inference, and worker code behind the adapter seams owned by the relevant Pi README.

Do not add cloud dependencies or let worker telemetry mutate game state directly.

Run the master and worker validation commands documented by their nearest README after changes.

Host-side tests do not prove QNX, AI-module qualification, phone-camera, or deployed hardware behavior.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
