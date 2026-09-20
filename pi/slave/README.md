# Camera Worker Pi

This directory contains the portable worker core for a future multi-camera
deployment. The current v1 uses the captain's laptop plus Apple-phone still
photographs for setup, not a Raspberry Pi worker or live player-location
tracking. The core does not run game rules, ingest badge events, or own
authoritative state.

## Future multi-camera flow

If multi-camera tracking is enabled in the future, the authoritative adapter
owns the room-scan/floor-plan workflow. It captures the room, presents the floor
plan for approval, and then provides each camera Pi with a camera-specific
homography in one approved shared coordinate frame. The worker receives that result through
`WorkerCore::set_calibration()` (or initial `WorkerConfig::calibration`). It
remains `WaitingForCalibration` before approval, so it cannot publish guessed
locations. Once configured, each worker reports live marker/person positions in
the same world coordinates for the master/UI to display.

This worker remains generic: it does not assume a recipe, ingredient, station,
or level-specific interaction. Room scanning and floor-plan approval are
control-plane responsibilities of the master and are intentionally represented
here by the approved calibration input rather than by a fake camera scanner.

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

`worker_demo` uses simulated inputs only: an identity homography stands in for
an approved room-scan floor plan, marker `7` is configured as player `1`, and a
synthetic track reports one feet point. It demonstrates the post-approval
shared-coordinate path; it is not a room-scan implementation or QNX hardware
validation.

## Operational behavior

Calibration is node-specific and must be loaded from deployment configuration;
the core has no identity-coordinate fallback. Tracking observations are
replaceable state, not an event log. A transport may use a best-effort local
protocol for tracking and a reliable local protocol for control/health, but it
must not expose this worker to the public internet. If the master is down, the
worker keeps only a bounded amount of current telemetry and continues local
capture/inference. The master must reject observations once their timestamp is
stale according to its own configured freshness policy.
