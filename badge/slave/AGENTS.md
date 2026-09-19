# Player badge guidance

The player app contract is [`README.md`](README.md).

Read [`../badge-app-guide.md`](../badge-app-guide.md) for supported APIs and [`../../README.md`](../../README.md) for current v1 interactions and lifecycle.

Keep this subtree responsible for NFC and motion intent capture, bounded local feedback, and player-badge transmission.

Do not claim that local feedback is authoritative acceptance, and do not implement game state or delivery authority here.

Keep semantic tag mappings, payload shape, retry behavior, and physical verification status in the component README.

Run `python -m unittest discover -s badge/slave/tests -p 'test_*.py'` from the repository root.

Run `python badge/run_local.py` when validating the local transport path.

Physical badge NFC, radio range, LED behavior, and firmware compatibility remain hardware-only checks.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
