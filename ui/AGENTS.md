# UI component guidance

The UI contract, transport seam, rendering ownership, and tests are [`README.md`](README.md).

Read [`../README.md`](../README.md), [`../updates/UPDATE_v1.md`](../updates/UPDATE_v1.md), [`../updates/UPDATE_v1.1.md`](../updates/UPDATE_v1.1.md), and [`../FLOW.md`](../FLOW.md) for product context.

Keep the UI offline-first and local, with the laptop server as the current
source of authoritative state. A future authoritative-engine adapter must stay
behind that server-owned transport boundary.

Render player icons, held items, chopping state, cooking progress, orders, health, and submission results from transport snapshots.

Do not decrement timers, infer locations, validate plates, score orders, or mutate game authority in the renderer.

Run `npm test` from this directory after UI changes.

Use the mock transport for offline development and keep HTTP integration behind the documented transport interface.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
