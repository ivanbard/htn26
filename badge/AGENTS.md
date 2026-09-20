# Badge component guidance

Read [`../README.md`](../README.md) and the accepted product decisions in [`../updates/UPDATE_v1.md`](../updates/UPDATE_v1.md) and [`../updates/UPDATE_v1.1.md`](../updates/UPDATE_v1.1.md) before changing badge behavior.

Read [`badge-app-guide.md`](badge-app-guide.md) before using or describing any Hacker Badge API.

Use the nearest component README as the owner for gateway, player, NFC display, and native implementation contracts.

Treat [`native/README.md`](native/README.md) as the production/live badge
profile. The Lua host/player apps are whole-fleet rollback only; never mix
their radio profile with native. Keep the native backup-first, factory-only,
security-preserving deployment gate unchanged.

The current production host is the laptop-local server/UI connected through
the USB gateway. QNX is only a possible future target, not a current badge
requirement or validation claim.

Keep badge apps focused on input capture and local feedback; shared
authoritative game state belongs to the laptop server or a future
authoritative-engine adapter, while each player badge keeps the local
held/controller state it displays and reports.

Do not invent Wi-Fi, HTTP, arbitrary BLE, serial-input, or radio capabilities that the badge guide does not document.

Keep radio payload and gateway framing details in the owning badge READMEs rather than duplicating them here.

Run the relevant badge test suite from the repository root after documentation or app changes.

Use `python badge/run_local.py` for the documented local transport smoke path.

The captain reports the native binary working on physical badges except that
bumping two badges together remains unverified. Treat generated-icon and
held-display emulator tests as offline evidence only; they do not establish
physical rendering or bump acceptance. Keep the exact evidence boundary in
[`native/README.md`](native/README.md).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
