# NFC display guidance

The standalone display app contract and upload steps are [`README.md`](README.md).

Use [`../badge-app-guide.md`](../badge-app-guide.md) as the only badge API authority.

Keep this subtree a diagnostic NFC reader and display example, not a game-state or transport component.

Do not add undocumented NDEF writing, record enumeration, networking, or badge APIs.

Run `python -m unittest discover -s badge/nfc_display/tests -p 'test_*.py' -v` from the repository root.

A physical badge and NFC tag are required for hardware validation.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
