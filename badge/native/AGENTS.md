# Native badge guidance

The production/live native extension contract and hardware safety gate are [`README.md`](README.md). Lua is whole-fleet rollback only; never mix native and Lua radio profiles.

Read [`../badge-app-guide.md`](../badge-app-guide.md), [`NATIVE_INVESTIGATION.md`](../NATIVE_INVESTIGATION.md), and [`RADIO_PROTOCOL.md`](RADIO_PROTOCOL.md) before changing native badge work.

Keep this subtree limited to the pinned native extension and its offline verification artifacts. The current production host is the laptop-local server/UI over the USB gateway; QNX is only a possible future target.

Do not treat generated build output, factory images, icon-selection emulation, or other offline tests as physical acceptance. The captain reports the native binary working except that physical badge-to-badge bumping remains unverified; the generated-icon display also needs an on-device visual check.

Do not change protected badge partitions or security configuration without the explicit hardware gate in the component README.

Run `python badge/native/test_build.py` and `python badge/native/test_payload.py` after a native build, with the documented local dependencies installed.

Physical flashing and acceptance remain separate from host-side validation.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
