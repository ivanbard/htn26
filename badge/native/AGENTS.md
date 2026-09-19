# Native badge guidance

The native extension contract and hardware safety gate are [`README.md`](README.md).

Read [`../badge-app-guide.md`](../badge-app-guide.md), [`NATIVE_INVESTIGATION.md`](../NATIVE_INVESTIGATION.md), and [`RADIO_PROTOCOL.md`](RADIO_PROTOCOL.md) before changing native badge work.

Keep this subtree limited to the pinned native extension and its offline verification artifacts.

Do not treat generated build output, factory images, or offline emulation as physical acceptance.

Do not change protected badge partitions or security configuration without the explicit hardware gate in the component README.

Run `python badge/native/test_build.py` and `python badge/native/test_payload.py` after a native build, with the documented local dependencies installed.

Physical flashing and acceptance remain separate from host-side validation.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
