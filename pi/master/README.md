# Future portable master engine

## Role

The production authority is the laptop-hosted `pi/server` process. This
directory contains a portable C++ engine retained for a possible future
Raspberry Pi or QNX target. If integrated later, it would combine badge intent,
fresh camera observations, and deterministic game rules; worker processes and
badges would not mutate whichever server is authoritative.

This directory contains a portable C++ MVP core. Its worker-observation and
delivery fixtures are implementation slices from before the current
laptop-hosted v1 product brief; they are not current v1 product claims. QNX
device and network code
belongs behind the interfaces in `src/platform_adapters.hpp`.

## MVP implementation

The authoritative engine is in `src/master_engine.*`. The shared wire
contract and gateway parser are in `../common/protocol.*`, so gateway, worker,
and master implementations have one definition of the packet fields.

The MVP implements one deterministic `TOMATO_SOUP` order:

1. `N|ING:TOM` at the tomato source.
2. `N|STN:CHOP1` and `M|CHOP` at the chopping zone.
3. Chopping completes, then `N|STN:POT1` starts cooking.
4. Cooking completes, then `N|STN:PLATE` plates the soup.
5. `N|STN:DELIVERY` delivers it and awards the score.

The serial parser searches for `HTN26|` inside noisy lines, validates the MAC,
RSSI, `OC1` payload, sequence, type, value, and payload length, then the engine
maps the normalized MAC to a player. It retains the current fixed-player `E`
event type at this transport boundary. The portable tomato-soup fixture does
not claim to apply the burger action vocabulary (`P2:PU:R`, etc.); that semantic
adapter remains an explicit integration boundary. A bounded `(sender MAC,
sequence)` cache suppresses retransmissions before game rules run.

Every location-sensitive intent requires a current observation from a healthy
worker, within configured age and confidence bounds. Worker observations are
accepted only from `MasterConfig::worker_nodes`; inputs cannot enroll a node.
Observations are
replaceable telemetry; per-node sequence numbers prevent old telemetry from
replacing newer telemetry. Heartbeats independently drive `HEALTHY`, `FAILED`,
and `STALE` worker states. Gateway RX/status lines drive gateway health. The
engine publishes versioned, coherent `GameState` snapshots through a callback
after inputs and timer transitions.

## Adapter boundary

`src/platform_adapters.hpp` defines small interfaces for:

* a monotonic clock;
* gateway USB-serial lines;
* worker tracking/heartbeat inputs; and
* state publication to a UI or diagnostic transport.

A QNX runtime adapter can implement these using `/dev/ser*`, local camera and
network APIs, and the QNX monotonic clock, then feed the core. No QNX headers,
sockets, cloud services, or hardware assumptions are present in the core.

The qualifying QNX AI module required by the overall project has not been
selected or hardware-validated by this MVP. Do not claim QNX device/runtime or
AI validation from the local tests.

This is a standalone tomato-soup core, not the three-badge host implementation.
The physical gateway plate events, worker types, and UI still need adapters;
see [integration boundaries](../../badge/LOCAL_TESTING.md). In particular, the
test `STN:DELIVERY` intent does not make delivery a player-badge responsibility.

## Local validation

The test executable covers noisy and malformed serial parsing, badge mapping,
location/confidence rejection, the complete badge-intent to soup-delivery
flow, `(MAC, sequence)` duplicate suppression, chopping/cooking/order timers,
state publication, and worker failure/stale tracking behavior.

```sh
make -C pi/master test
```

Build the minimal QNX runtime and test it with a simulated gateway status line:

```sh
make -C pi/master smoke
```

Run it with newline-delimited gateway output on stdin, or pass the gateway's
serial device as the second argument:

```sh
/tmp/htn26-master-build/htn26_master_server AA:BB:CC:DD:EE:FF
/tmp/htn26-master-build/htn26_master_server AA:BB:CC:DD:EE:FF /dev/ser1
```

The runtime currently registers one badge and prints event results and state
snapshots. Camera/worker input and UI publication remain outside this first
deployment slice.

`CMakeLists.txt` also defines the same C++17 test target for environments with
CMake and CTest. The local tests use workstation C++ only.

## Non-goals

Do not initially implement:

* cloud synchronization;
* facial recognition;
* voice control;
* complex physics;
* distributed consensus between Pis;
* master-Pi failover; or
* direct Pi-to-player-badge commands.
