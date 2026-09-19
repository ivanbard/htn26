#include "htn26/worker_adapters.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace htn26::slave {
namespace {

bool finite(double value) { return std::isfinite(value); }

double bounded_confidence(double value) {
  if (!finite(value))
    return 0.0;
  return std::clamp(value, 0.0, 1.0);
}

} // namespace

bool Homography::valid(double epsilon) const {
  for (double value : values) {
    if (!finite(value))
      return false;
  }

  const double determinant =
      values[0] * (values[4] * values[8] - values[5] * values[7]) -
      values[1] * (values[3] * values[8] - values[5] * values[6]) +
      values[2] * (values[3] * values[7] - values[4] * values[6]);
  return finite(determinant) && std::abs(determinant) > epsilon;
}

std::optional<WorldPoint> Homography::project(ImagePoint image,
                                              double epsilon) const {
  if (!valid(epsilon) || !finite(image.x) || !finite(image.y)) {
    return std::nullopt;
  }

  const double world_x = values[0] * image.x + values[1] * image.y + values[2];
  const double world_y = values[3] * image.x + values[4] * image.y + values[5];
  const double denominator =
      values[6] * image.x + values[7] * image.y + values[8];
  if (!finite(denominator) || std::abs(denominator) <= epsilon) {
    return std::nullopt;
  }

  WorldPoint result{world_x / denominator, world_y / denominator};
  if (!finite(result.x) || !finite(result.y))
    return std::nullopt;
  return result;
}

ReplaceableObservationQueue::ReplaceableObservationQueue(std::size_t capacity)
    : capacity_(std::max<std::size_t>(1, capacity)) {}

bool ReplaceableObservationQueue::is_stale(TimePoint timestamp, TimePoint now,
                                           Duration stale_after) {
  if (now < timestamp)
    return false;
  return now - timestamp > stale_after;
}

std::size_t ReplaceableObservationQueue::discard_stale(TimePoint now,
                                                       Duration stale_after) {
  std::size_t removed = 0;
  for (auto it = queue_.begin(); it != queue_.end();) {
    if (is_stale(it->timestamp, now, stale_after)) {
      it = queue_.erase(it);
      ++removed;
      ++stale_drop_count_;
    } else {
      ++it;
    }
  }
  return removed;
}

bool ReplaceableObservationQueue::push(TrackingObservation observation,
                                       TimePoint now, Duration stale_after) {
  discard_stale(now, stale_after);
  bool replaced = false;
  if (queue_.size() >= capacity_) {
    queue_.pop_front();
    ++replacement_count_;
    replaced = true;
  }
  queue_.push_back(std::move(observation));
  return !replaced;
}

std::optional<TrackingObservation>
ReplaceableObservationQueue::take_latest(TimePoint now, Duration stale_after) {
  discard_stale(now, stale_after);
  if (queue_.empty())
    return std::nullopt;

  TrackingObservation latest = std::move(queue_.back());
  queue_.clear();
  return latest;
}

void ReplaceableObservationQueue::clear() { queue_.clear(); }

IdentityAssociator::IdentityAssociator(
    std::unordered_map<MarkerId, PlayerId> marker_to_player,
    Duration identity_hold)
    : marker_to_player_(std::move(marker_to_player)),
      identity_hold_(std::max(identity_hold, Duration::zero())) {}

void IdentityAssociator::prune(TimePoint now) {
  for (auto it = tracks_.begin(); it != tracks_.end();) {
    if (now >= it->second.last_seen &&
        now - it->second.last_seen > identity_hold_) {
      it = tracks_.erase(it);
    } else {
      ++it;
    }
  }
}

std::optional<PlayerId>
IdentityAssociator::associate(const Detection &detection, TimePoint now) {
  prune(now);
  if (detection.track_id < 0)
    return std::nullopt;

  auto &track = tracks_[detection.track_id];
  track.last_seen = now;

  if (detection.marker_visible) {
    // A visible marker that is not provisioned is explicitly unknown.  Never
    // retain the prior player identity in this case.
    if (detection.marker_id) {
      const auto mapped = marker_to_player_.find(*detection.marker_id);
      if (mapped != marker_to_player_.end()) {
        track.player_id = mapped->second;
        track.identity_expires = now + identity_hold_;
        return track.player_id;
      }
    }
    track.player_id.reset();
    track.identity_expires = now;
    return std::nullopt;
  }

  if (track.player_id && now <= track.identity_expires) {
    return track.player_id;
  }
  track.player_id.reset();
  return std::nullopt;
}

void IdentityAssociator::clear() { tracks_.clear(); }

WorkerCore::WorkerCore(WorkerConfig config)
    : config_(std::move(config)), calibration_(config_.calibration),
      identities_(config_.marker_to_player, config_.identity_hold),
      outgoing_(config_.outgoing_observation_capacity) {
  if (config_.tracking_stale_after < Duration::zero()) {
    config_.tracking_stale_after = Duration::zero();
  }
  if (config_.heartbeat_interval <= Duration::zero()) {
    config_.heartbeat_interval = std::chrono::milliseconds(1);
  }
  if (!calibration_ || !calibration_->valid())
    calibration_.reset();

  // Until an injected adapter reports a failure, the core is ready to accept
  // its input.  Runtime startup updates these flags with actual adapter state.
  diagnostics_.camera = Health::Healthy;
  diagnostics_.inference = Health::Healthy;
  diagnostics_.network = Health::Healthy;
  diagnostics_.calibration_ready = calibration_.has_value();
  recompute_state();
}

void WorkerCore::set_calibration(std::optional<Calibration> calibration) {
  if (!calibration || !calibration->valid()) {
    calibration_.reset();
  } else {
    calibration_ = std::move(calibration);
  }
  diagnostics_.calibration_ready = calibration_.has_value();
  latest_observation_.reset();
  last_inference_timestamp_.reset();
  diagnostics_.effective_fps = 0.0;
  identities_.clear();
  outgoing_.clear();
  recompute_state();
}

void WorkerCore::set_master_available(bool available) {
  master_available_ = available;
  diagnostics_.network = available ? Health::Healthy : Health::Unavailable;
  recompute_state();
}

void WorkerCore::report_camera_status(bool healthy) {
  diagnostics_.camera = healthy ? Health::Healthy : Health::Unavailable;
  recompute_state();
}

void WorkerCore::report_inference_status(bool healthy) {
  diagnostics_.inference = healthy ? Health::Healthy : Health::Unavailable;
  recompute_state();
}

std::optional<TrackingObservation>
WorkerCore::process_detections(TimePoint timestamp,
                               const std::vector<Detection> &detections,
                               Duration inference_latency) {
  if (last_inference_timestamp_ && timestamp < *last_inference_timestamp_) {
    return std::nullopt;
  }

  diagnostics_.last_inference_latency =
      std::max(inference_latency, Duration::zero());

  if (last_inference_timestamp_ && timestamp > *last_inference_timestamp_) {
    const std::chrono::duration<double> seconds =
        timestamp - *last_inference_timestamp_;
    if (seconds.count() > 0.0) {
      diagnostics_.effective_fps = 1.0 / seconds.count();
    }
  }
  last_inference_timestamp_ = timestamp;

  if (!calibration_) {
    diagnostics_.calibration_ready = false;
    recompute_state();
    return std::nullopt;
  }

  TrackingObservation observation;
  observation.node_id = config_.node_id;
  observation.camera_id = config_.camera_id;
  observation.sequence = next_sequence_++;
  observation.timestamp = timestamp;
  observation.players.reserve(detections.size());

  std::size_t known = 0;
  std::size_t unknown = 0;
  for (const Detection &detection : detections) {
    const auto world =
        calibration_->image_to_world.project(detection.image_position);
    if (!world)
      continue;

    PlayerObservation player;
    player.track_id = detection.track_id;
    player.player_id = identities_.associate(detection, timestamp);
    player.position = *world;
    player.confidence = bounded_confidence(detection.confidence);
    if (player.player_id) {
      ++known;
    } else {
      ++unknown;
    }
    observation.players.push_back(std::move(player));
  }

  diagnostics_.known_tracks = known;
  diagnostics_.unknown_tracks = unknown;
  latest_observation_ = observation;
  outgoing_.push(observation, timestamp, config_.tracking_stale_after);
  sync_queue_diagnostics();
  recompute_state();
  return observation;
}

bool WorkerCore::tracking_is_fresh(TimePoint now) const {
  if (!latest_observation_)
    return false;
  if (now < latest_observation_->timestamp)
    return false;
  return now - latest_observation_->timestamp <= config_.tracking_stale_after;
}

std::optional<TrackingObservation>
WorkerCore::latest_observation(TimePoint now) const {
  if (!tracking_is_fresh(now))
    return std::nullopt;
  return latest_observation_;
}

std::optional<TrackingObservation>
WorkerCore::take_latest_observation(TimePoint now) {
  const auto result = outgoing_.take_latest(now, config_.tracking_stale_after);
  sync_queue_diagnostics();
  return result;
}

std::optional<Heartbeat> WorkerCore::heartbeat_if_due(TimePoint now) {
  if (next_heartbeat_ && now < *next_heartbeat_)
    return std::nullopt;

  // Set the next deadline from the time observed now, not from the old
  // deadline.  A stalled loop therefore emits one heartbeat, never a burst.
  next_heartbeat_ = now + config_.heartbeat_interval;
  return make_heartbeat(now);
}

void WorkerCore::record_master_send(bool success, TimePoint now) {
  if (success) {
    master_available_ = true;
    diagnostics_.network = Health::Healthy;
    diagnostics_.last_master_send = now;
  } else {
    master_available_ = false;
    diagnostics_.network = Health::Unavailable;
    ++diagnostics_.failed_master_sends;
  }
  recompute_state();
}

void WorkerCore::recompute_state() {
  diagnostics_.calibration_ready = calibration_.has_value();
  if (!calibration_) {
    state_ = WorkerState::WaitingForCalibration;
  } else if (diagnostics_.camera != Health::Healthy) {
    state_ = WorkerState::CameraUnavailable;
  } else if (diagnostics_.inference != Health::Healthy) {
    state_ = WorkerState::InferenceUnavailable;
  } else if (!master_available_) {
    state_ = WorkerState::MasterUnavailable;
  } else {
    state_ = WorkerState::Running;
  }
}

Heartbeat WorkerCore::make_heartbeat(TimePoint now) const {
  Heartbeat heartbeat;
  heartbeat.node_id = config_.node_id;
  heartbeat.camera_id = config_.camera_id;
  heartbeat.timestamp = now;
  heartbeat.state = state_;
  heartbeat.camera = diagnostics_.camera;
  heartbeat.inference = diagnostics_.inference;
  heartbeat.network = diagnostics_.network;
  heartbeat.calibration_ready = diagnostics_.calibration_ready;
  heartbeat.effective_fps = diagnostics_.effective_fps;
  heartbeat.known_tracks = diagnostics_.known_tracks;
  heartbeat.unknown_tracks = diagnostics_.unknown_tracks;
  return heartbeat;
}

void WorkerCore::sync_queue_diagnostics() {
  const auto replacements = outgoing_.replacement_count();
  if (replacements > observed_replacements_) {
    diagnostics_.replaced_outgoing_observations +=
        replacements - observed_replacements_;
    observed_replacements_ = replacements;
  }
  const auto stale_drops = outgoing_.stale_drop_count();
  if (stale_drops > observed_stale_drops_) {
    diagnostics_.stale_outgoing_observations +=
        stale_drops - observed_stale_drops_;
    observed_stale_drops_ = stale_drops;
  }
}

WorkerRuntime::WorkerRuntime(WorkerCore &core, CameraAdapter &camera,
                             InferenceAdapter &inference,
                             MasterTransport &master)
    : core_(core), camera_(camera), inference_(inference), master_(master) {}

bool WorkerRuntime::start() {
  if (started_)
    return true;

  const AdapterResult camera_result = camera_.initialize();
  core_.report_camera_status(camera_result.ok);
  const AdapterResult inference_result = inference_.initialize();
  core_.report_inference_status(inference_result.ok);
  started_ = camera_result.ok && inference_result.ok;
  if (!started_) {
    if (camera_result.ok)
      camera_.shutdown();
    if (inference_result.ok)
      inference_.shutdown();
    core_.report_camera_status(false);
    core_.report_inference_status(false);
  }
  return started_;
}

bool WorkerRuntime::run_once(TimePoint now) {
  if (!started_)
    return false;

  bool cycle_ok = true;
  CameraFrame frame;
  const AdapterResult capture_result = camera_.capture(frame);
  if (!capture_result.ok) {
    core_.report_camera_status(false);
    cycle_ok = false;
  } else {
    core_.report_camera_status(true);
    const TimePoint frame_time =
        frame.captured_at == TimePoint{} ? now : frame.captured_at;
    const InferenceResult result = inference_.infer(frame, now);
    if (!result.ok) {
      core_.report_inference_status(false);
      cycle_ok = false;
    } else {
      core_.report_inference_status(true);
      core_.process_detections(frame_time, result.detections, result.latency);
    }
  }

  // A failed send consumes the current replaceable state.  The next frame
  // supersedes it rather than building a backlog while the master is down.
  if (const auto observation = core_.take_latest_observation(now)) {
    core_.record_master_send(master_.send_tracking(*observation), now);
  }
  if (const auto heartbeat = core_.heartbeat_if_due(now)) {
    core_.record_master_send(master_.send_heartbeat(*heartbeat), now);
  }
  return cycle_ok;
}

void WorkerRuntime::shutdown() {
  if (!started_)
    return;
  camera_.shutdown();
  inference_.shutdown();
  started_ = false;
  core_.report_camera_status(false);
  core_.report_inference_status(false);
}

} // namespace htn26::slave
