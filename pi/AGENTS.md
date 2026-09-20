# Raspberry Pi component guidance

Read [`../README.md`](../README.md), [`../updates/UPDATE_v1.md`](../updates/UPDATE_v1.md), [`../updates/UPDATE_v1.1.md`](../updates/UPDATE_v1.1.md), and [`../FLOW.md`](../FLOW.md) before changing Pi behavior.

Use [`README.md`](README.md), [`difficulty/README.md`](difficulty/README.md),
[`master/README.md`](master/README.md), and [`slave/README.md`](slave/README.md)
as the implementation owners for the Pi components.

The current authoritative server run, test, and deployment path is the
captain's laptop. QNX may host only the optional label-only difficulty sidecar;
QNX authoritative execution and multi-camera workers remain future boundaries.

Keep authoritative game state, timers, order/recipe selection, scoring,
inventory, layout, badge state, and submission decisions in the laptop server
or a future authoritative-engine adapter. The difficulty sidecar contract may
return only `easy`, `normal`, or `hectic` with model/source metadata and
latency; follow [`difficulty/README.md`](difficulty/README.md).

Keep camera, inference, and worker code behind the adapter seams owned by the relevant Pi README.

Do not add cloud dependencies or let worker telemetry mutate game state directly.

Run the sidecar, master, and worker validation commands documented by their nearest README after changes.

Host-side tests do not prove QNX, AI-module qualification, phone-camera, or deployed hardware behavior.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
