# Badge component guidance

Read [`../README.md`](../README.md) and the accepted product decisions in [`../updates/UPDATE_v1.md`](../updates/UPDATE_v1.md) and [`../updates/UPDATE_v1.1.md`](../updates/UPDATE_v1.1.md) before changing badge behavior.

Read [`badge-app-guide.md`](badge-app-guide.md) before using or describing any Hacker Badge API.

Use the nearest component README as the owner for gateway, player, NFC display, and native implementation contracts.

Keep badge apps focused on input capture and local feedback; authoritative game state belongs to the Pi.

Do not invent Wi-Fi, HTTP, arbitrary BLE, serial-input, or radio capabilities that the badge guide does not document.

Keep radio payload and gateway framing details in the owning badge READMEs rather than duplicating them here.

Run the relevant badge test suite from the repository root after documentation or app changes.

Use `python badge/run_local.py` for the documented local transport smoke path.

Physical badge behavior remains unvalidated until an IDE upload and hardware run are performed.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
