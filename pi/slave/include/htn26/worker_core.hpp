#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace htn26::slave {

using Clock = std::chrono::steady_clock;
using TimePoint = Clock::time_point;
using Duration = Clock::duration;
using MarkerId = int;
using PlayerId = int;

struct ImagePoint {
  double x = 0.0;
  double y = 0.0;
};

struct WorldPoint {
  double x = 0.0;
  double y = 0.0;
};

/**
 * A camera-specific image-to-world projective transform.
 *
 * The matrix is row-major and maps [x, y, 1] to homogeneous world
 * coordinates.  A worker never substitutes an identity transform: a
 * calibration must be supplied and pass valid().
 */
struct Homography {
  std::array<double, 9> values{};

  bool valid(double epsilon = 1e-12) const;
  std::optional<WorldPoint> project(ImagePoint image,
                                    double epsilon = 1e-12) const;
};

struct Calibration {
  Homography image_to_world;

  bool valid() const { return image_to_world.valid(); }
};

/** A person detection supplied by the AI adapter. */
struct Detection {
  int track_id = -1;
  ImagePoint image_position{}; // Use a stable ground-contact/feet point.
  double confidence = 0.0;

  // marker_visible distinguishes an occluded marker from a visible but
  // unprovisioned marker.  The latter must not inherit a previous identity.
  bool marker_visible = false;
  std::optional<MarkerId> marker_id;
};

struct PlayerObservation {
  int track_id = -1;
  std::optional<PlayerId> player_id;
  WorldPoint position{};
  double confidence = 0.0;
};

struct TrackingObservation {
  std::string node_id;
  std::string camera_id;
  std::uint64_t sequence = 0;
  TimePoint timestamp{};
  std::vector<PlayerObservation> players;
};

enum class WorkerState {
  WaitingForCalibration,
  Running,
  MasterUnavailable,
  CameraUnavailable,
  InferenceUnavailable,
};

enum class Health {
  Unavailable,
  Healthy,
};

struct Heartbeat {
  std::string node_id;
  std::string camera_id;
  TimePoint timestamp{};
  WorkerState state = WorkerState::WaitingForCalibration;
  Health camera = Health::Unavailable;
  Health inference = Health::Unavailable;
  Health network = Health::Unavailable;
  bool calibration_ready = false;
  double effective_fps = 0.0;
  std::size_t known_tracks = 0;
  std::size_t unknown_tracks = 0;
};

struct WorkerDiagnostics {
  Health camera = Health::Unavailable;
  Health inference = Health::Unavailable;
  Health network = Health::Unavailable;
  bool calibration_ready = false;
  Duration last_inference_latency{};
  double effective_fps = 0.0;
  std::optional<TimePoint> last_master_send;
  std::size_t known_tracks = 0;
  std::size_t unknown_tracks = 0;
  std::size_t replaced_outgoing_observations = 0;
  std::size_t stale_outgoing_observations = 0;
  std::size_t failed_master_sends = 0;
};

struct WorkerConfig {
  std::string node_id;
  std::string camera_id;
  std::optional<Calibration> calibration;
  std::unordered_map<MarkerId, PlayerId> marker_to_player;
  Duration tracking_stale_after = std::chrono::milliseconds(500);
  Duration identity_hold = std::chrono::milliseconds(400);
  Duration heartbeat_interval = std::chrono::seconds(1);
  std::size_t outgoing_observation_capacity = 2;
};

/**
 * Bounded FIFO for replaceable tracking state.
 *
 * It is intentionally not an event queue.  When full, the oldest frame is
 * replaced; callers can also take_latest() to discard intermediate frames.
 */
class ReplaceableObservationQueue {
public:
  explicit ReplaceableObservationQueue(std::size_t capacity);

  bool push(TrackingObservation observation, TimePoint now,
            Duration stale_after);
  std::optional<TrackingObservation> take_latest(TimePoint now,
                                                 Duration stale_after);
  void clear();
  std::size_t discard_stale(TimePoint now, Duration stale_after);
  std::size_t size() const { return queue_.size(); }
  std::size_t capacity() const { return capacity_; }
  std::size_t replacement_count() const { return replacement_count_; }
  std::size_t stale_drop_count() const { return stale_drop_count_; }

private:
  static bool is_stale(TimePoint timestamp, TimePoint now,
                       Duration stale_after);

  std::size_t capacity_;
  std::deque<TrackingObservation> queue_;
  std::size_t replacement_count_ = 0;
  std::size_t stale_drop_count_ = 0;
};

/** Associates visible deterministic markers and expires hidden identities. */
class IdentityAssociator {
public:
  IdentityAssociator(std::unordered_map<MarkerId, PlayerId> marker_to_player,
                     Duration identity_hold);

  std::optional<PlayerId> associate(const Detection &detection, TimePoint now);
  void clear();

private:
  struct TrackIdentity {
    std::optional<PlayerId> player_id;
    TimePoint last_seen{};
    TimePoint identity_expires{};
  };

  void prune(TimePoint now);

  std::unordered_map<MarkerId, PlayerId> marker_to_player_;
  Duration identity_hold_;
  std::unordered_map<int, TrackIdentity> tracks_;
};

/**
 * Platform-independent worker state machine.  Camera and AI implementations
 * feed it detections; QNX-specific adapters remain outside this class.
 */
class WorkerCore {
public:
  explicit WorkerCore(WorkerConfig config);

  WorkerState state() const { return state_; }
  const WorkerDiagnostics &diagnostics() const { return diagnostics_; }

  void set_calibration(std::optional<Calibration> calibration);
  void set_master_available(bool available);
  void report_camera_status(bool healthy);
  void report_inference_status(bool healthy);

  // Returns the locally produced observation even when the master is down.
  // No observation is produced while calibration is unavailable/invalid.
  std::optional<TrackingObservation>
  process_detections(TimePoint timestamp,
                     const std::vector<Detection> &detections,
                     Duration inference_latency);

  // These methods describe local freshness, not master delivery status.
  bool tracking_is_fresh(TimePoint now) const;
  std::optional<TrackingObservation> latest_observation(TimePoint now) const;

  // Removes intermediate frames and returns the newest non-stale frame.
  std::optional<TrackingObservation> take_latest_observation(TimePoint now);

  // At most one heartbeat is generated per call and missed intervals do not
  // cause a burst.  This is the bounded heartbeat scheduler.
  std::optional<Heartbeat> heartbeat_if_due(TimePoint now);

  // A failed send moves the worker to MasterUnavailable.  A successful send
  // recovers it (provided calibration and local adapters are healthy).
  void record_master_send(bool success, TimePoint now);

private:
  void recompute_state();
  Heartbeat make_heartbeat(TimePoint now) const;
  void sync_queue_diagnostics();

  WorkerConfig config_;
  std::optional<Calibration> calibration_;
  IdentityAssociator identities_;
  ReplaceableObservationQueue outgoing_;
  WorkerState state_ = WorkerState::WaitingForCalibration;
  WorkerDiagnostics diagnostics_;
  bool master_available_ = true;
  std::uint64_t next_sequence_ = 1;
  std::optional<TimePoint> next_heartbeat_;
  std::optional<TimePoint> last_inference_timestamp_;
  std::optional<TrackingObservation> latest_observation_;
  std::size_t observed_replacements_ = 0;
  std::size_t observed_stale_drops_ = 0;
};

} // namespace htn26::slave
