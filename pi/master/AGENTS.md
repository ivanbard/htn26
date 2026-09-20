# Master Pi guidance

The master implementation contract is [`README.md`](README.md).

Read [`../../README.md`](../../README.md), [`../../updates/UPDATE_v1.1.md`](../../updates/UPDATE_v1.1.md), and [`../common/AGENTS.md`](../common/AGENTS.md) before changing engine or parser behavior.

Keep this subtree authoritative for its portable engine contract. The current
v1 laptop simulator and possible future engine-adapter boundary are documented
by [`../server/README.md`](../server/README.md) and [`README.md`](README.md).

Keep shared wire fields in `../common/` and platform details behind the adapter interfaces described in the component README.

Do not let the UI, badges, workers, or camera setup bypass master invariants.

Run `make -C pi/master test` from the repository root for the portable engine.

Run `make -C pi/master smoke` for the documented runtime smoke build.

These commands use workstation or simulated inputs and do not validate QNX deployment or the phone camera.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
