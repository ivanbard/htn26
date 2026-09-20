# Shared Pi protocol guidance

The shared wire implementation is in [`protocol.hpp`](protocol.hpp) and [`protocol.cpp`](protocol.cpp).

Read [`../README.md`](../README.md) and [`../master/README.md`](../master/README.md) before changing shared fields or parsing behavior.

Keep shared protocol definitions centralized here and avoid component-specific copies.

Do not place product rules, camera inference, or UI behavior in this directory.

Validate changes with `make -C pi/master test` from the repository root.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
