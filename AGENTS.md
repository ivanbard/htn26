# Project agent guidance

Read [`README.md`](README.md) for the current laptop-hosted, phone-photo v1
product intent before changing documentation or code.

Read [`updates/UPDATE_v1.md`](updates/UPDATE_v1.md) and [`updates/UPDATE_v1.1.md`](updates/UPDATE_v1.1.md) for the accepted product decisions, with v1.1 taking precedence where the two differ.

Read [`FLOW.md`](FLOW.md) for the broader flow reference, while treating the current README and accepted updates as the v1 product summary.

Read [`badge/badge-app-guide.md`](badge/badge-app-guide.md) before touching any badge app or badge API assumption.

For badge deployment after the observed Lua/NimBLE memory failures, follow the
whole-fleet native/rollback and factory-only safety gate in
[`badge/native/README.md`](badge/native/README.md); never mix native and Lua radio profiles.

Use the nearest component README as the implementation contract for [`badge/`](badge/README.md), [`pi/`](pi/README.md), [`server/`](server/README.md), and [`ui/`](ui/README.md).

The current/latest laptop development surfaces are root [`server/`](server/) and [`ui/`](ui/). Keep the HTTP/SSE, photo, provider, AI layout, endpoint catalog, and canonical snapshot contract in `server/`; do not create a competing server under `pi/`.

Treat QNX setup inference and difficulty direction as future adapter/sidecar
boundaries. They must not duplicate game rules or take ownership of the root
HTTP/photo/layout surface.

Keep product intent in the root README and implementation-specific packet, API, state, and transport details in their existing component owners.

Do not change product code for documentation-only tasks.

Run `npm test` in `ui/` for UI changes.

Run `node --test server/test/*.test.mjs` for root server changes.

Run `make -C pi/master test` for the portable master engine and follow [`pi/slave/README.md`](pi/slave/README.md) for worker validation.

Run the badge tests listed in the relevant badge README when changing badge documentation or apps.

Report documentation changes and distinguish host-side validation from physical badge, phone-camera, and QNX validation.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
