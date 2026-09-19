#pragma once

#include "pi/common/protocol.hpp"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace htn26::master {

enum class GamePhase { Idle, Running, Completed, Expired };
enum class Item { Empty, RawTomato, ChoppedTomato, CookedSoup, SoupPlate };
enum class StationKind { None, TomatoSource, Chopping, Pot, Plate, Delivery };
enum class ProcessingState { Idle, Chopping, Cooking };
enum class HealthState { Unknown, Healthy, Failed, Stale };

enum class ActionCode {
  Accepted,
  Completed,
  Duplicate,
  Malformed,
  UnknownBadge,
  NotRunning,
  UnsupportedIntent,
  StaleOrLowConfidence,
  InvalidState,
  ExpiredOrder,
  InvalidObservation,
  StaleObservation,
  InvalidHeartbeat,
};

struct Zone {
  double min_x = 0.0;
  double min_y = 0.0;
  double max_x = 0.0;
  double max_y = 0.0;

  bool contains(double x, double y) const;
};

struct MasterConfig {
  std::uint64_t position_stale_ms = 1000;
  std::uint64_t worker_stale_ms = 1500;
  std::uint64_t gateway_stale_ms = 3000;
  std::uint64_t chopping_duration_ms = 1000;
  std::uint64_t cooking_duration_ms = 3000;
  std::uint64_t order_duration_ms = 30000;
  double minimum_position_confidence = 0.75;
  std::size_t dedup_capacity = 512;
  std::vector<std::string> worker_nodes = {"cam1", "pi2", "pi3"};
  std::map<StationKind, Zone> zones;

  static MasterConfig defaults();
};

struct PlayerState {
  int id = 0;
  std::string badge_mac;
  bool has_position = false;
  double x = 0.0;
  double y = 0.0;
  double position_confidence = 0.0;
  std::uint64_t position_timestamp_ms = 0;
  StationKind current_zone = StationKind::None;
  Item held_item = Item::Empty;
  std::string action_state = "idle";
};

struct StationState {
  StationKind kind = StationKind::None;
  Item contents = Item::Empty;
  ProcessingState processing = ProcessingState::Idle;
  std::uint64_t processing_deadline_ms = 0;
  int processing_player_id = 0;
};

struct OrderState {
  int id = 1;
  std::string recipe = "TOMATO_SOUP";
  bool active = false;
  bool completed = false;
  bool expired = false;
  std::uint64_t deadline_ms = 0;
  int score_value = 100;
};

struct WorkerHealth {
  HealthState state = HealthState::Unknown;
  bool has_heartbeat = false;
  std::uint64_t last_heartbeat_received_ms = 0;
  std::uint64_t last_heartbeat_sequence = 0;
  double fps = 0.0;
};

struct GatewayHealth {
  HealthState state = HealthState::Unknown;
  std::uint64_t last_received_ms = 0;
  std::uint64_t packet_count = 0;
  std::uint64_t dropped_count = 0;
};

struct GameState {
  std::uint64_t version = 0;
  std::uint64_t now_ms = 0;
  GamePhase phase = GamePhase::Idle;
  int score = 0;
  std::map<int, PlayerState> players;
  std::map<StationKind, StationState> stations;
  OrderState order;
  GatewayHealth gateway;
  std::map<std::string, WorkerHealth> workers;
};

struct ActionResult {
  ActionCode code = ActionCode::InvalidState;
  bool accepted = false;
  std::string detail;
  std::uint64_t state_version = 0;
};

// The core has no serial, socket, camera, clock, or UI dependencies. Hardware
// adapters feed these typed values into this class and subscribe to snapshots.
class MasterEngine {
 public:
  using StateListener = std::function<void(const GameState&)>;

  explicit MasterEngine(MasterConfig config = MasterConfig::defaults());

  bool register_badge(std::string_view mac, int player_id);
  bool start_game(std::uint64_t now_ms);
  bool reset_game(std::uint64_t now_ms);

  // Gateway serial input. Both RX and gateway status lines are accepted.
  ActionResult ingest_serial_line(std::string_view line, std::uint64_t now_ms);

  // Replaceable worker input paths. These are safe to call from an adapter
  // loop; no worker is allowed to mutate game state directly.
  ActionResult receive_tracking(const protocol::WorkerObservation& observation,
                                std::uint64_t now_ms);
  ActionResult receive_heartbeat(const protocol::WorkerHeartbeat& heartbeat,
                                 std::uint64_t now_ms);
  ActionResult receive_gateway_status(const protocol::GatewayStatus& status,
                                      std::uint64_t now_ms);

  // Advances all deterministic timers and health transitions. now_ms must be
  // from a monotonic clock supplied by the platform adapter.
  void tick(std::uint64_t now_ms);

  void set_state_listener(StateListener listener);
  const GameState& state() const { return state_; }
  const MasterConfig& config() const { return config_; }

  HealthState worker_state(std::string_view node) const;
  bool player_is_at(int player_id, StationKind station,
                    std::uint64_t now_ms) const;

 private:
  struct StoredObservation {
    protocol::PlayerObservation observation;
    std::uint64_t node_sequence = 0;
  };

  MasterConfig config_;
  GameState state_;
  std::unordered_map<std::string, int> badge_to_player_;
  std::map<std::string, std::map<int, StoredObservation>> observations_;
  std::map<std::string, std::uint64_t> latest_observation_sequence_;
  std::unordered_set<std::string> seen_event_keys_;
  std::vector<std::string> seen_event_order_;
  StateListener state_listener_;

  void publish();
  bool set_health_for_time(std::uint64_t now_ms);
  bool update_fused_positions(std::uint64_t now_ms);
  std::optional<protocol::PlayerObservation> best_observation(
      int player_id, std::uint64_t now_ms) const;
  bool require_location(int player_id, StationKind station,
                        std::uint64_t now_ms, ActionResult& result) const;
  ActionResult apply_intent(const protocol::BadgeIntent& intent,
                            std::uint64_t now_ms);
  ActionResult reject(ActionCode code, std::string detail) const;
  ActionResult accept(std::string detail, bool completed = false) const;
  bool remember_event(const protocol::BadgeIntent& intent);
  void complete_processing(std::uint64_t now_ms);
  void clear_round_state();
  static std::string event_key(const protocol::BadgeIntent& intent);
};

const char* to_string(GamePhase phase);
const char* to_string(Item item);
const char* to_string(StationKind station);
const char* to_string(ProcessingState processing);
const char* to_string(HealthState health);
const char* to_string(ActionCode code);

}  // namespace htn26::master
