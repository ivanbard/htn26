# Camera Worker Pi

This directory contains the portable worker core deployed to each non-master
camera Pi. The same process is configured with different `node_id` and
`camera_id` values (for example `pi2/cam2` and `pi3/cam3`). The core does not
run game rules, ingest badge events, or own authoritative state.

## Implemented MVP

`include/htn26/worker_core.hpp` and `src/worker_core.cpp` provide a host-testable
worker state machine that:

* accepts person detections from an injected inference adapter;
* maps a visible deterministic marker to a configured player ID, without facial
  recognition;
* preserves a known identity only for a bounded occlusion hold, and reports
  an unprovisioned or expired identity as unknown;
* requires a valid configured 3x3 image-to-world homography and never invents
  coordinates when calibration is absent or invalid;
* emits replaceable tracking observations in shared world coordinates;
* bounds outgoing telemetry, replaces old tracking frames when full, and drops
  stale frames instead of accumulating them;
* generates at most one heartbeat per due check and does not burst missed
  heartbeat intervals;
* reports camera, inference, calibration, network, latency, FPS, known/unknown
  tracks, send failures, and replaced/stale outgoing frames;
* continues local detection while the master is unavailable and recovers when a
  send succeeds; and
* enters explicit states for missing calibration, camera/inference failure, and
  master unavailability.

The feet/ground-contact point of each detection should be supplied as
`image_position`. A detection with `marker_visible == true` and an unmapped
`marker_id` is deliberately unknown. A temporarily occluded marker uses the
same local `track_id` and is retained only until the configured identity hold
expires.

## Adapter seams

`include/htn26/worker_adapters.hpp` defines the narrow platform boundary:

* `CameraAdapter` owns the QNX camera capture handle;
* `InferenceAdapter` owns the local person/marker inference pipeline; and
* `MasterTransport` owns the local-network send implementation.

`WorkerRuntime` orchestrates those adapters without QNX headers, sockets, or
camera SDK assumptions. `CameraFrame::native_handle` is intentionally opaque.
A QNX process should implement these interfaces using the selected camera
pipeline and AI module, then feed detections to `WorkerCore`.

### QNX AI qualification

The qualifying module status is owned by [`pi/README.md`](../README.md). The
MVP keeps the narrow `InferenceAdapter` seam until a candidate is verified;
this directory does not claim QNX camera, AI hardware, or embedded deployment
validation.


## Build and host tests

From the repository root:

```sh
cmake -S pi/slave -B pi/slave/build
cmake --build pi/slave/build
ctest --test-dir pi/slave/build --output-on-failure
pi/slave/build/worker_demo
```

The tests cover homography projection and rejection, freshness and stale
tracking behavior, bounded queue replacement, unknown identity handling,
heartbeat generation without bursts, and camera/master failure recovery.

## Operational behavior

Calibration is node-specific and must be loaded from deployment configuration;
the core has no identity-coordinate fallback. Tracking observations are
replaceable state, not an event log. A transport may use a best-effort local
protocol for tracking and a reliable local protocol for control/health, but it
must not expose this worker to the public internet. If the master is down, the
worker keeps only a bounded amount of current telemetry and continues local
capture/inference. The master must reject observations once their timestamp is
stale according to its own configured freshness policy.
