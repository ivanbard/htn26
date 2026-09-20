# Project agent guidance

## Orientation

Read [`README.md`](README.md) for the current one-Pi phone-camera v1 product intent before changing documentation or code.

Read [`updates/UPDATE_v1.md`](updates/UPDATE_v1.md) and [`updates/UPDATE_v1.1.md`](updates/UPDATE_v1.1.md) for the accepted product decisions, with v1.1 taking precedence where the two differ.

Read [`FLOW.md`](FLOW.md) for the broader flow reference and [`DEPLOY.md`](DEPLOY.md) for deployment, the hardware gate, and the first-playable-run flow.

Every component subtree has its own `AGENTS.md` (`badge/`, `pi/`, `ui/`, and their children); follow the nearest one before editing that subtree.

`CLAUDE.md` only imports this file; edit `AGENTS.md`, not `CLAUDE.md`.

## Architecture invariants

- The Pi owns authoritative game state, orders, cooking/order timers, and scoring. The host badge owns only the four-minute round lifecycle. The UI mirrors state and never decrements timers or scores locally. Player badges report intent and are never authoritative.
- Badge apps have no Wi-Fi/HTTP/arbitrary BLE. Radio payloads are 1–44 bytes and delivery is unreliable; deduplicate by sender MAC + sequence. Read [`badge/badge-app-guide.md`](badge/badge-app-guide.md) before touching any badge app or API assumption, and do not invent undocumented capabilities.
- Badge apps run only in the foreground; radio listeners stop after returning HOME.
- Gameplay must not depend on cloud services. `OPENAI_API_KEY` is optional and must stay in the Pi server environment only.
- The qualifying QNX AI module (sponsor track, must come from oss.qnx.com) is unresolved; status is owned by [`pi/README.md`](pi/README.md).

## Badge deployment safety

After the observed Lua/NimBLE memory failures, follow the whole-fleet native/rollback and factory-only safety gate in [`badge/native/README.md`](badge/native/README.md); never mix native and Lua radio profiles in one fleet or round. The Lua apps in `badge/master/` and `badge/slave/` are the retained rollback profile, not dead code.

## Validation

There is intentionally no CI (`.no-mistakes.yaml`); run the relevant suites yourself before reporting work done.

Python test/build dependencies install into the gitignored `.tools/` tree, not the system environment. Commands run from the repository root:

```sh
# UI (Node 20+; React + Vite; tests use only Node's built-in runner)
(cd ui && npm test)

# Pi portable master engine, plus its serial smoke build
make -C pi/master test
make -C pi/master smoke

# Pi camera worker core (CMake + CTest)
cmake -S pi/slave -B pi/slave/build && cmake --build pi/slave/build && ctest --test-dir pi/slave/build --output-on-failure

# Pi server slice (Node 20+ stdlib only; no package.json)
(cd pi/server && node --test test/*.test.mjs)

# Badge Lua apps (lupa required once; tests bootstrap .tools/python themselves)
python -m pip install --target .tools/python lupa==2.8
python -m unittest discover -s badge/master/tests -p 'test_*.py' -v
python -m unittest discover -s badge/slave/tests -p 'test_*.py' -v
python badge/run_local.py   # local transport smoke path

# Native badge extension (pinned Zig 0.14.1 + Unicorn; details in badge/native/README.md)
python -m pip install --target .tools/native ziglang==0.14.1
python -m pip install --target .tools/reverse unicorn==2.1.4
python badge/native/build.py
python badge/native/test_build.py
python badge/native/test_payload.py
python badge/native/ble_receiver.py --self-test
```

These commands validate host-side behavior only. They do not prove physical badge, phone-camera, QNX, radio, or NFC hardware behavior; distinguish that when reporting results.

## Documentation boundaries

Use the nearest component README as the implementation contract for [`badge/`](badge/README.md), [`pi/`](pi/README.md), and [`ui/`](ui/README.md).

Keep product intent in the root README and implementation-specific packet, API, state, and transport details in their existing component owners; do not duplicate those contracts in root-level files.

Do not change product code for documentation-only tasks.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
