# Player badge guidance

[`README.md`](README.md) owns the rollback-only Lua player contract. The production/live player is the native role in [`../native/README.md`](../native/README.md); never mix profiles.

Read [`../badge-app-guide.md`](../badge-app-guide.md) for supported APIs and [`../../README.md`](../../README.md) for current v1 interactions and lifecycle.

Keep this subtree responsible for NFC and motion intent capture, bounded local feedback, and player-badge transmission.

Do not claim that local feedback is authoritative acceptance, and do not implement game state or delivery authority here.

Keep semantic tag mappings, payload shape, retry behavior, and physical verification status in the component README.

Run `python -m unittest discover -s badge/slave/tests -p 'test_*.py'` from the repository root.

Run `python badge/run_local.py` when validating the local transport path.

Offline tests do not prove physical NFC, radio, LEDs, display rendering, or bump behavior. The captain reports the native binary working except that two-badge bumping remains unverified; keep the exact boundary in the native README.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
