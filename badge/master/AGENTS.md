# Gateway badge guidance

The gateway implementation contract is [`README.md`](README.md).

The badge API boundary is [`../badge-app-guide.md`](../badge-app-guide.md), and the current product lifecycle is [`../../README.md`](../../README.md) with accepted clarifications in [`../../updates/UPDATE_v1.1.md`](../../updates/UPDATE_v1.1.md).

Keep this subtree responsible for host or gateway controls, radio and NFC capture, bounded forwarding, and local health feedback.

Do not move authoritative game rules, timers, scoring, or UI state ownership into the gateway badge.

Keep packet validation, queue limits, and serial framing in this README and the implementation rather than redefining them in root documentation.

Run `python -m unittest discover -s badge/master/tests -p 'test_*.py'` from the repository root for gateway protocol tests.

Run `python badge/run_local.py` for the local forwarding smoke path.

Physical radio, NFC, and USB serial checks require badge hardware.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
