#include "htn26/worker_adapters.hpp"
#include "htn26/worker_core.hpp"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

namespace {

using namespace htn26::slave;
using namespace std::chrono_literals;

TimePoint at_ms(int value) {
  return TimePoint{std::chrono::milliseconds(value)};
}

Calibration unit_calibration() {
  return Calibration{Homography{{1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0}}};
}

WorkerConfig config() {
  WorkerConfig result;
  result.node_id = "pi2";
  result.camera_id = "cam2";
  result.calibration = unit_calibration();
  result.marker_to_player.emplace(42, 2);
  result.tracking_stale_after = 200ms;
  result.identity_hold = 100ms;
  result.heartbeat_interval = 1000ms;
  result.outgoing_observation_capacity = 2;
  return result;
}

Detection detection(int track, double x, double y, double confidence,
                    bool marker_visible = false,
                    std::optional<MarkerId> marker = std::nullopt) {
  Detection result;
  result.track_id = track;
  result.image_position = ImagePoint{x, y};
  result.confidence = confidence;
  result.marker_visible = marker_visible;
  result.marker_id = marker;
  return result;
}

TrackingObservation observation(std::uint64_t sequence, int timestamp_ms) {
  TrackingObservation result;
  result.sequence = sequence;
  result.timestamp = at_ms(timestamp_ms);
  return result;
}

void require(bool condition, const std::string &message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(EXIT_FAILURE);
  }
}

void test_homography() {
  Homography transform{{2.0, 0.0, 1.0, 0.0, 3.0, -1.0, 0.0, 0.0, 1.0}};
  require(transform.valid(), "non-singular homography is valid");
  const auto mapped = transform.project(ImagePoint{4.0, 2.0});
  require(mapped.has_value(), "homography projects an image point");
  require(mapped->x == 9.0 && mapped->y == 5.0,
          "homography maps to configured world coordinates");

  Homography singular{{1.0, 2.0, 3.0, 2.0, 4.0, 6.0, 0.0, 0.0, 0.0}};
  require(!singular.valid(), "singular calibration is rejected");
  require(!singular.project(ImagePoint{1.0, 1.0}),
          "invalid calibration cannot invent a coordinate");
}

void test_freshness_and_stale_data() {
  WorkerCore core(config());
  const auto produced =
      core.process_detections(at_ms(1000), {detection(1, 3.0, 4.0, 0.9)}, 12ms);
  require(produced.has_value(), "calibrated worker produces an observation");
  require(core.tracking_is_fresh(at_ms(1200)),
          "observation is fresh at boundary");
  require(!core.tracking_is_fresh(at_ms(1201)),
          "observation becomes stale after configured age");
  require(!core.latest_observation(at_ms(1201)),
          "stale observation is not returned to game logic");

  ReplaceableObservationQueue queue(1);
  queue.push(observation(1, 0), at_ms(0), 50ms);
  require(!queue.take_latest(at_ms(51), 50ms),
          "stale outgoing frame is discarded instead of sent");
  require(queue.stale_drop_count() == 1, "stale discard is diagnosed");
}

void test_out_of_order_detections_are_rejected() {
  WorkerCore core(config());
  require(
      core.process_detections(at_ms(100), {detection(1, 10.0, 10.0, 0.8)}, 4ms)
          .has_value(),
      "newer detection is accepted");
  require(!core.process_detections(at_ms(99), {detection(1, 99.0, 99.0, 0.8)},
                                   20ms),
          "older detection is rejected");
  const auto latest = core.latest_observation(at_ms(100));
  require(latest && latest->timestamp == at_ms(100) &&
              latest->players[0].position.x == 10.0,
          "older detection cannot replace the latest observation");
  require(core.diagnostics().last_inference_latency == 4ms,
          "rejected detection does not overwrite diagnostics");
}

void test_bounded_replacement() {
  ReplaceableObservationQueue queue(2);
  queue.push(observation(1, 0), at_ms(0), 1s);
  queue.push(observation(2, 10), at_ms(10), 1s);
  queue.push(observation(3, 20), at_ms(20), 1s);
  require(queue.size() == 2, "outgoing queue remains bounded");
  require(queue.replacement_count() == 1,
          "oldest replaceable frame is dropped when full");
  const auto latest = queue.take_latest(at_ms(20), 1s);
  require(latest && latest->sequence == 3,
          "newest tracking state wins over older frames");
  require(queue.size() == 0,
          "taking latest clears obsolete intermediate frames");
}

void test_unknown_identity_and_bounded_hold() {
  WorkerCore core(config());
  auto known = core.process_detections(
      at_ms(0), {detection(7, 1.0, 2.0, 0.8, true, 42)}, 1ms);
  require(known && known->players[0].player_id == 2,
          "configured marker deterministically identifies a player");

  auto temporarily_hidden =
      core.process_detections(at_ms(50), {detection(7, 1.1, 2.1, 0.8)}, 1ms);
  require(temporarily_hidden && temporarily_hidden->players[0].player_id == 2,
          "occluded marker is retained only during the short hold window");

  auto expired =
      core.process_detections(at_ms(151), {detection(7, 1.2, 2.2, 0.8)}, 1ms);
  require(expired && !expired->players[0].player_id,
          "identity expires rather than being preserved forever");

  auto unknown_marker = core.process_detections(
      at_ms(160), {detection(8, 1.0, 2.0, 0.8, true, 999)}, 1ms);
  require(unknown_marker && !unknown_marker->players[0].player_id,
          "visible unprovisioned marker remains explicitly unknown");
  require(unknown_marker->players[0].position.x == 1.0,
          "unknown tracks still carry calibrated position");

  auto invalid_identified = core.process_detections(
      at_ms(170), {detection(-1, 1.0, 2.0, 0.8, true, 42)}, 1ms);
  require(invalid_identified && !invalid_identified->players[0].player_id,
          "invalid tracker IDs remain unknown even with a known marker");
  auto invalid_hidden =
      core.process_detections(at_ms(180), {detection(-1, 1.0, 2.0, 0.8)}, 1ms);
  require(invalid_hidden && !invalid_hidden->players[0].player_id,
          "invalid tracker IDs do not retain identity across detections");
}

void test_heartbeat_scheduler() {
  WorkerCore core(config());
  require(core.heartbeat_if_due(at_ms(0)).has_value(),
          "heartbeat is generated immediately");
  require(!core.heartbeat_if_due(at_ms(999)),
          "heartbeat is not generated before interval");
  const auto heartbeat = core.heartbeat_if_due(at_ms(1000));
  require(heartbeat && heartbeat->node_id == "pi2" &&
              heartbeat->camera_id == "cam2",
          "heartbeat carries node diagnostics");
  require(!core.heartbeat_if_due(at_ms(1001)),
          "heartbeat schedule remains bounded");
  require(core.heartbeat_if_due(at_ms(5000)).has_value(),
          "a delayed loop emits one heartbeat");
  require(!core.heartbeat_if_due(at_ms(5001)),
          "missed heartbeat intervals do not create a burst");
}

void test_failure_recovery() {
  WorkerConfig missing = config();
  missing.calibration.reset();
  WorkerCore core(missing);
  require(core.state() == WorkerState::WaitingForCalibration,
          "missing calibration enters an explicit waiting state");
  require(
      !core.process_detections(at_ms(0), {detection(1, 1.0, 1.0, 0.9)}, 1ms),
      "worker does not produce coordinates without calibration");

  core.set_calibration(unit_calibration());
  require(core.state() == WorkerState::Running,
          "valid calibration recovers the worker");
  core.set_master_available(false);
  require(core.state() == WorkerState::MasterUnavailable,
          "master loss is explicit and non-blocking");
  require(core.process_detections(at_ms(10), {detection(1, 1.0, 1.0, 0.9)}, 1ms)
              .has_value(),
          "local capture/inference continues while master is unavailable");
  core.record_master_send(false, at_ms(10));
  require(core.diagnostics().failed_master_sends == 1,
          "network failure is reported");
  core.record_master_send(true, at_ms(20));
  require(core.state() == WorkerState::Running,
          "successful master send recovers the worker");

  core.report_camera_status(false);
  require(core.state() == WorkerState::CameraUnavailable,
          "camera failure is explicit");
  core.report_camera_status(true);
  require(core.state() == WorkerState::Running,
          "camera recovery returns to running state");
}

void test_calibration_reset_clears_track_diagnostics() {
  WorkerCore core(config());
  require(core.process_detections(at_ms(0),
                                  {detection(1, 1.0, 1.0, 0.8, true, 42),
                                   detection(2, 2.0, 2.0, 0.8)},
                                  1ms)
              .has_value(),
          "calibrated worker records track diagnostics");
  require(core.diagnostics().known_tracks == 1 &&
              core.diagnostics().unknown_tracks == 1,
          "track diagnostics reflect the latest observation");

  core.set_calibration(std::nullopt);
  require(core.diagnostics().known_tracks == 0 &&
              core.diagnostics().unknown_tracks == 0,
          "clearing calibration clears stale track diagnostics");

  core.set_calibration(unit_calibration());
  require(core.process_detections(at_ms(10), {detection(3, 3.0, 3.0, 0.8)}, 1ms)
              .has_value(),
          "replacement calibration accepts new observations");
  require(core.diagnostics().known_tracks == 0 &&
              core.diagnostics().unknown_tracks == 1,
          "replacement calibration reports only current tracks");
}

struct FakeCamera final : CameraAdapter {
  bool initialize_ok = true;
  bool capture_ok = true;
  int shutdowns = 0;
  AdapterResult initialize() override { return {initialize_ok, "fake camera"}; }
  AdapterResult capture(CameraFrame &frame) override {
    if (!capture_ok)
      return {false, "capture failed"};
    frame.sequence++;
    frame.captured_at = at_ms(10);
    return {true, "captured"};
  }
  void shutdown() override { ++shutdowns; }
};

struct FakeInference final : InferenceAdapter {
  bool initialize_ok = true;
  bool infer_ok = true;
  int shutdowns = 0;
  AdapterResult initialize() override { return {initialize_ok, "fake AI"}; }
  InferenceResult infer(const CameraFrame &, TimePoint) override {
    InferenceResult result;
    result.ok = infer_ok;
    result.latency = 3ms;
    if (infer_ok)
      result.detections.push_back(detection(1, 2.0, 3.0, 0.7));
    result.detail = "fake inference";
    return result;
  }
  void shutdown() override { ++shutdowns; }
};

struct FakeMaster final : MasterTransport {
  bool send_ok = true;
  int tracking_messages = 0;
  int heartbeat_messages = 0;
  bool send_tracking(const TrackingObservation &) override {
    ++tracking_messages;
    return send_ok;
  }
  bool send_heartbeat(const Heartbeat &) override {
    ++heartbeat_messages;
    return send_ok;
  }
};

void test_runtime_adapter_failure_recovery() {
  WorkerCore core(config());
  FakeCamera camera;
  FakeInference inference;
  FakeMaster master;
  WorkerRuntime runtime(core, camera, inference, master);
  require(runtime.start(), "runtime starts with healthy injected adapters");
  require(runtime.run_once(at_ms(0)), "runtime processes an adapter frame");
  require(master.tracking_messages == 1 && master.heartbeat_messages == 1,
          "runtime sends tracking and heartbeat output");

  camera.capture_ok = false;
  require(!runtime.run_once(at_ms(20)), "camera failure is surfaced to caller");
  require(core.state() == WorkerState::CameraUnavailable,
          "camera failure transitions runtime state");
  camera.capture_ok = true;
  require(runtime.run_once(at_ms(30)),
          "camera recovers without rebuilding core");
  require(core.state() == WorkerState::Running,
          "camera recovery restores running state");
  runtime.shutdown();
  require(camera.shutdowns == 1, "runtime shuts down camera adapter");
}

void test_runtime_cleans_up_partial_startup() {
  WorkerCore core(config());
  FakeCamera camera;
  FakeInference inference;
  FakeMaster master;
  WorkerRuntime runtime(core, camera, inference, master);

  inference.initialize_ok = false;
  require(!runtime.start(), "runtime rejects failed inference startup");
  require(camera.shutdowns == 1 && inference.shutdowns == 0,
          "runtime cleans up only the successfully initialized adapter");
  require(!runtime.run_once(at_ms(0)), "failed startup cannot run a cycle");
}

void test_inference_failure_is_not_cleared_by_core_processing() {
  WorkerCore core(config());
  core.report_inference_status(false);
  require(core.process_detections(at_ms(0), {detection(1, 1.0, 1.0, 0.8)}, 1ms)
              .has_value(),
          "processing can retain a locally produced observation");
  require(core.state() == WorkerState::InferenceUnavailable,
          "processing cannot clear an inference failure");
  core.report_inference_status(true);
  require(core.process_detections(at_ms(1), {detection(1, 1.0, 1.0, 0.8)}, 1ms)
              .has_value(),
          "explicit inference recovery permits processing");
}

} // namespace

int main() {
  test_homography();
  test_freshness_and_stale_data();
  test_out_of_order_detections_are_rejected();
  test_bounded_replacement();
  test_unknown_identity_and_bounded_hold();
  test_heartbeat_scheduler();
  test_failure_recovery();
  test_calibration_reset_clears_track_diagnostics();
  test_runtime_adapter_failure_recovery();
  test_runtime_cleans_up_partial_startup();
  test_inference_failure_is_not_cleared_by_core_processing();
  std::cout << "worker_core_tests: all tests passed\n";
  return EXIT_SUCCESS;
}
