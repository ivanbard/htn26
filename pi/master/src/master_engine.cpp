#include "master_engine.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace htn26::master {
namespace {

std::uint64_t add_ms(std::uint64_t base, std::uint64_t duration) {
  const auto maximum = std::numeric_limits<std::uint64_t>::max();
  if (duration > maximum - base) {
    return maximum;
  }
  return base + duration;
}

bool same_double(double left, double right) {
  return std::abs(left - right) < 0.000001;
}

bool same_observation(const PlayerState &player,
                      const protocol::PlayerObservation &observation,
                      StationKind zone) {
  return player.has_position && same_double(player.x, observation.x) &&
         same_double(player.y, observation.y) &&
         same_double(player.position_confidence, observation.confidence) &&
         player.position_timestamp_ms == observation.timestamp_ms &&
         player.current_zone == zone;
}

StationKind zone_for(const MasterConfig &config, double x, double y) {
  for (const auto &[station, zone] : config.zones) {
    if (station != StationKind::None && zone.contains(x, y)) {
      return station;
    }
  }
  return StationKind::None;
}

} // namespace

bool Zone::contains(double x, double y) const {
  return x >= min_x && x < max_x && y >= min_y && y < max_y;
}

MasterConfig MasterConfig::defaults() {
  MasterConfig config;
  config.zones[StationKind::TomatoSource] = {0.0, 0.0, 1.0, 1.0};
  config.zones[StationKind::Chopping] = {1.0, 0.0, 2.0, 1.0};
  config.zones[StationKind::Pot] = {2.0, 0.0, 3.0, 1.0};
  config.zones[StationKind::Plate] = {3.0, 0.0, 4.0, 1.0};
  config.zones[StationKind::Delivery] = {4.0, 0.0, 5.0, 1.0};
  return config;
}

MasterEngine::MasterEngine(MasterConfig config) : config_(std::move(config)) {
  if (config_.zones.empty()) {
    config_.zones = MasterConfig::defaults().zones;
  }
  for (const StationKind station :
       {StationKind::TomatoSource, StationKind::Chopping, StationKind::Pot,
        StationKind::Plate, StationKind::Delivery}) {
    StationState state;
    state.kind = station;
    state_.stations.emplace(station, state);
  }
  state_.order = OrderState{};
  for (const std::string &node : config_.worker_nodes) {
    if (!node.empty()) {
      state_.workers.emplace(node, WorkerHealth{});
    }
  }
}

bool MasterEngine::register_badge(std::string_view mac, int player_id) {
  const std::string normalized = protocol::normalize_mac(mac);
  if (normalized.empty() || player_id <= 0) {
    return false;
  }
  const auto existing_mac = badge_to_player_.find(normalized);
  if (existing_mac != badge_to_player_.end() &&
      existing_mac->second != player_id) {
    return false;
  }

  auto player = state_.players.find(player_id);
  if (player != state_.players.end() && !player->second.badge_mac.empty() &&
      player->second.badge_mac != normalized) {
    badge_to_player_.erase(player->second.badge_mac);
  }
  badge_to_player_[normalized] = player_id;
  PlayerState &player_state = state_.players[player_id];
  player_state.id = player_id;
  player_state.badge_mac = normalized;
  publish();
  return true;
}

void MasterEngine::clear_round_state() {
  state_.phase = GamePhase::Idle;
  state_.score = 0;
  state_.order = OrderState{};
  for (auto &[station, station_state] : state_.stations) {
    (void)station;
    station_state.contents = Item::Empty;
    station_state.processing = ProcessingState::Idle;
    station_state.processing_deadline_ms = 0;
    station_state.processing_player_id = 0;
  }
  for (auto &[player_id, player] : state_.players) {
    (void)player_id;
    player.held_item = Item::Empty;
    player.action_state = "idle";
  }
}

bool MasterEngine::start_game(std::uint64_t now_ms) {
  clear_round_state();
  state_.now_ms = now_ms;
  state_.phase = GamePhase::Running;
  state_.order.active = true;
  state_.order.deadline_ms = add_ms(now_ms, config_.order_duration_ms);
  publish();
  return true;
}

bool MasterEngine::reset_game(std::uint64_t now_ms) {
  return start_game(now_ms);
}

void MasterEngine::set_state_listener(StateListener listener) {
  state_listener_ = std::move(listener);
}

void MasterEngine::publish() {
  ++state_.version;
  if (state_listener_) {
    state_listener_(state_);
  }
}

ActionResult MasterEngine::reject(ActionCode code, std::string detail) const {
  ActionResult result;
  result.code = code;
  result.accepted = false;
  result.detail = std::move(detail);
  result.state_version = state_.version;
  return result;
}

ActionResult MasterEngine::accept(std::string detail, bool completed) const {
  ActionResult result;
  result.code = completed ? ActionCode::Completed : ActionCode::Accepted;
  result.accepted = true;
  result.detail = std::move(detail);
  result.state_version = state_.version;
  return result;
}

std::string MasterEngine::event_key(const protocol::BadgeIntent &intent) {
  return intent.sender_mac + "#" + std::to_string(intent.sequence);
}

bool MasterEngine::remember_event(const protocol::BadgeIntent &intent) {
  const std::string key = event_key(intent);
  seen_event_keys_.insert(key);
  seen_event_order_.push_back(key);
  const std::size_t capacity = std::max<std::size_t>(1, config_.dedup_capacity);
  while (seen_event_order_.size() > capacity) {
    seen_event_keys_.erase(seen_event_order_.front());
    seen_event_order_.erase(seen_event_order_.begin());
  }
  return true;
}

bool MasterEngine::has_seen_event(const protocol::BadgeIntent &intent) const {
  return seen_event_keys_.find(event_key(intent)) != seen_event_keys_.end();
}

bool MasterEngine::set_health_for_time(std::uint64_t now_ms) {
  bool changed = false;
  if (state_.gateway.state == HealthState::Healthy &&
      now_ms >= state_.gateway.last_received_ms &&
      now_ms - state_.gateway.last_received_ms > config_.gateway_stale_ms) {
    state_.gateway.state = HealthState::Stale;
    changed = true;
  } else if (state_.gateway.state == HealthState::Unknown &&
             now_ms >= config_.gateway_stale_ms) {
    state_.gateway.state = HealthState::Stale;
    changed = true;
  }

  for (auto &[node, health] : state_.workers) {
    (void)node;
    if (health.state == HealthState::Healthy &&
        now_ms >= health.last_heartbeat_received_ms &&
        now_ms - health.last_heartbeat_received_ms > config_.worker_stale_ms) {
      health.state = HealthState::Stale;
      changed = true;
    } else if (health.state == HealthState::Unknown &&
               now_ms >= config_.worker_stale_ms) {
      health.state = HealthState::Stale;
      changed = true;
    }
  }
  return changed;
}

std::optional<protocol::PlayerObservation>
MasterEngine::best_observation(int player_id, std::uint64_t now_ms) const {
  std::optional<protocol::PlayerObservation> best;
  for (const auto &[node, by_player] : observations_) {
    const auto health = state_.workers.find(node);
    if (health == state_.workers.end() ||
        health->second.state != HealthState::Healthy) {
      continue;
    }
    const auto observation = by_player.find(player_id);
    if (observation == by_player.end()) {
      continue;
    }
    const auto &candidate = observation->second.observation;
    if (candidate.timestamp_ms > now_ms ||
        now_ms - candidate.timestamp_ms > config_.position_stale_ms ||
        candidate.confidence < config_.minimum_position_confidence) {
      continue;
    }
    if (!best || candidate.confidence > best->confidence ||
        (same_double(candidate.confidence, best->confidence) &&
         candidate.timestamp_ms > best->timestamp_ms)) {
      best = candidate;
    }
  }
  return best;
}

bool MasterEngine::update_fused_positions(std::uint64_t now_ms) {
  bool changed = false;
  for (auto &[player_id, player] : state_.players) {
    const auto candidate = best_observation(player_id, now_ms);
    if (!candidate) {
      if (player.has_position || player.current_zone != StationKind::None) {
        player.has_position = false;
        player.position_confidence = 0.0;
        player.current_zone = StationKind::None;
        changed = true;
      }
      continue;
    }

    const StationKind zone = zone_for(config_, candidate->x, candidate->y);
    if (!same_observation(player, *candidate, zone)) {
      player.has_position = true;
      player.x = candidate->x;
      player.y = candidate->y;
      player.position_confidence = candidate->confidence;
      player.position_timestamp_ms = candidate->timestamp_ms;
      player.current_zone = zone;
      changed = true;
    }
  }
  return changed;
}

bool MasterEngine::player_is_at(int player_id, StationKind station,
                                std::uint64_t now_ms) const {
  const auto observation = best_observation(player_id, now_ms);
  return observation && config_.zones.count(station) != 0 &&
         config_.zones.at(station).contains(observation->x, observation->y);
}

bool MasterEngine::require_location(int player_id, StationKind station,
                                    std::uint64_t now_ms,
                                    ActionResult &result) const {
  const auto observation = best_observation(player_id, now_ms);
  if (!observation) {
    result = reject(ActionCode::StaleOrLowConfidence,
                    "fresh, confidence-bounded tracking is required");
    return false;
  }
  const auto zone = config_.zones.find(station);
  if (zone == config_.zones.end() ||
      !zone->second.contains(observation->x, observation->y)) {
    result = reject(ActionCode::InvalidState,
                    "player is outside the required station zone");
    return false;
  }
  return true;
}

void MasterEngine::complete_processing(std::uint64_t now_ms) {
  for (auto &[station_kind, station] : state_.stations) {
    (void)station_kind;
    if (station.processing == ProcessingState::Idle ||
        station.processing_deadline_ms > now_ms) {
      continue;
    }
    if (station.processing == ProcessingState::Chopping) {
      const auto player = state_.players.find(station.processing_player_id);
      if (player != state_.players.end()) {
        player->second.held_item = Item::ChoppedTomato;
        player->second.action_state = "holding chopped tomato";
      }
      station.contents = Item::Empty;
    } else if (station.processing == ProcessingState::Cooking) {
      station.contents = Item::CookedSoup;
      const auto player = state_.players.find(station.processing_player_id);
      if (player != state_.players.end()) {
        player->second.action_state = "soup ready";
      }
    }
    station.processing = ProcessingState::Idle;
    station.processing_deadline_ms = 0;
    station.processing_player_id = 0;
  }
}

ActionResult MasterEngine::apply_intent(const protocol::BadgeIntent &intent,
                                        std::uint64_t now_ms) {
  const auto mapped = badge_to_player_.find(intent.sender_mac);
  if (mapped == badge_to_player_.end()) {
    return reject(ActionCode::UnknownBadge,
                  "sender MAC is not assigned to a player");
  }
  const auto player_it = state_.players.find(mapped->second);
  if (player_it == state_.players.end()) {
    return reject(ActionCode::UnknownBadge, "mapped player is not registered");
  }
  if (state_.phase != GamePhase::Running) {
    return reject(state_.order.expired ? ActionCode::ExpiredOrder
                                       : ActionCode::NotRunning,
                  "game is not running");
  }

  PlayerState &player = player_it->second;
  ActionResult location_result;
  if (intent.type == 'N') {
    if (intent.value == "ING:TOM") {
      if (!require_location(player.id, StationKind::TomatoSource, now_ms,
                            location_result)) {
        return location_result;
      }
      if (player.held_item != Item::Empty) {
        return reject(ActionCode::InvalidState,
                      "player is already holding an item");
      }
      player.held_item = Item::RawTomato;
      player.action_state = "holding raw tomato";
      return accept("tomato picked up");
    }
    if (intent.value == "STN:CHOP1") {
      if (!require_location(player.id, StationKind::Chopping, now_ms,
                            location_result)) {
        return location_result;
      }
      auto &station = state_.stations.at(StationKind::Chopping);
      if (player.held_item != Item::RawTomato ||
          station.processing != ProcessingState::Idle ||
          station.contents != Item::Empty) {
        return reject(ActionCode::InvalidState,
                      "raw tomato and an idle chopping station are required");
      }
      player.held_item = Item::Empty;
      player.action_state = "at chopping station";
      station.contents = Item::RawTomato;
      return accept("tomato placed at chopping station");
    }
    if (intent.value == "STN:POT1") {
      if (!require_location(player.id, StationKind::Pot, now_ms,
                            location_result)) {
        return location_result;
      }
      auto &station = state_.stations.at(StationKind::Pot);
      if (player.held_item != Item::ChoppedTomato ||
          station.processing != ProcessingState::Idle ||
          station.contents != Item::Empty) {
        return reject(ActionCode::InvalidState,
                      "chopped tomato and an idle pot are required");
      }
      player.held_item = Item::Empty;
      player.action_state = "cooking soup";
      station.contents = Item::ChoppedTomato;
      station.processing = ProcessingState::Cooking;
      station.processing_deadline_ms =
          add_ms(now_ms, config_.cooking_duration_ms);
      station.processing_player_id = player.id;
      return accept("soup cooking");
    }
    if (intent.value == "STN:PLATE") {
      if (!require_location(player.id, StationKind::Plate, now_ms,
                            location_result)) {
        return location_result;
      }
      auto &pot = state_.stations.at(StationKind::Pot);
      if (player.held_item != Item::Empty || pot.contents != Item::CookedSoup ||
          pot.processing != ProcessingState::Idle) {
        return reject(ActionCode::InvalidState,
                      "cooked soup is not ready to plate");
      }
      pot.contents = Item::Empty;
      player.held_item = Item::SoupPlate;
      player.action_state = "holding plated soup";
      return accept("soup plated");
    }
    if (intent.value == "STN:DELIVERY") {
      if (!require_location(player.id, StationKind::Delivery, now_ms,
                            location_result)) {
        return location_result;
      }
      if (player.held_item != Item::SoupPlate) {
        return reject(ActionCode::InvalidState, "a plated soup is required");
      }
      if (!state_.order.active) {
        return reject(state_.order.expired ? ActionCode::ExpiredOrder
                                           : ActionCode::InvalidState,
                      "order is no longer active");
      }
      player.held_item = Item::Empty;
      player.action_state = "order delivered";
      state_.order.active = false;
      state_.order.completed = true;
      state_.phase = GamePhase::Completed;
      state_.score += state_.order.score_value;
      return accept("tomato soup delivered", true);
    }
    return reject(ActionCode::UnsupportedIntent, "unknown NFC intent");
  }

  if (intent.type == 'M' && intent.value == "CHOP") {
    if (!require_location(player.id, StationKind::Chopping, now_ms,
                          location_result)) {
      return location_result;
    }
    auto &station = state_.stations.at(StationKind::Chopping);
    if (player.action_state != "at chopping station" ||
        station.processing != ProcessingState::Idle ||
        station.contents != Item::RawTomato) {
      return reject(ActionCode::InvalidState,
                    "a tomato must be placed at the chopping station first");
    }
    station.processing = ProcessingState::Chopping;
    station.processing_deadline_ms =
        add_ms(now_ms, config_.chopping_duration_ms);
    station.processing_player_id = player.id;
    player.action_state = "chopping";
    return accept("chopping started");
  }

  return reject(ActionCode::UnsupportedIntent, "unsupported badge intent");
}

ActionResult MasterEngine::ingest_serial_line(std::string_view line,
                                              std::uint64_t now_ms) {
  const auto status = protocol::parse_gateway_status_line(line);
  if (status.ok) {
    return receive_gateway_status(status.status, now_ms);
  }

  const auto parsed = protocol::parse_gateway_rx_line(line);
  if (!parsed.ok) {
    return reject(ActionCode::Malformed, parsed.error);
  }

  state_.now_ms = now_ms;
  set_health_for_time(now_ms);
  update_fused_positions(now_ms);
  state_.gateway.state = HealthState::Healthy;
  state_.gateway.last_received_ms = now_ms;
  ++state_.gateway.packet_count;

  if (has_seen_event(parsed.intent)) {
    ActionResult duplicate =
        reject(ActionCode::Duplicate, "duplicate badge sequence ignored");
    publish();
    duplicate.state_version = state_.version;
    return duplicate;
  }

  ActionResult result = apply_intent(parsed.intent, now_ms);
  if (result.accepted) {
    remember_event(parsed.intent);
  }
  publish();
  result.state_version = state_.version;
  return result;
}

ActionResult
MasterEngine::receive_tracking(const protocol::WorkerObservation &observation,
                               std::uint64_t now_ms) {
  bool time_state_changed = state_.now_ms != now_ms;
  state_.now_ms = now_ms;
  time_state_changed = set_health_for_time(now_ms) || time_state_changed;
  time_state_changed = update_fused_positions(now_ms) || time_state_changed;
  auto reject_with_time_update = [&](ActionResult result) {
    if (time_state_changed) {
      publish();
      result.state_version = state_.version;
    }
    return result;
  };
  if (observation.node.empty() || observation.players.empty()) {
    return reject_with_time_update(
        reject(ActionCode::InvalidObservation,
               "tracking packet has no node or players"));
  }
  if (state_.workers.find(observation.node) == state_.workers.end()) {
    return reject_with_time_update(
        reject(ActionCode::InvalidObservation, "worker is not configured"));
  }
  const auto previous_sequence =
      latest_observation_sequence_.find(observation.node);
  if (previous_sequence != latest_observation_sequence_.end() &&
      observation.sequence <= previous_sequence->second) {
    return reject_with_time_update(
        reject(ActionCode::StaleObservation,
               "older tracking sequence cannot replace current telemetry"));
  }

  bool has_known_player = false;
  for (const auto &player : observation.players) {
    if (player.player_id <= 0 || !std::isfinite(player.x) ||
        !std::isfinite(player.y) || !std::isfinite(player.confidence) ||
        player.confidence < 0.0 || player.confidence > 1.0 ||
        player.timestamp_ms > now_ms) {
      return reject_with_time_update(
          reject(ActionCode::InvalidObservation,
                 "tracking packet contains an invalid player observation"));
    }
    if (state_.players.find(player.player_id) != state_.players.end()) {
      has_known_player = true;
    }
  }
  if (!has_known_player) {
    return reject_with_time_update(
        reject(ActionCode::InvalidObservation,
               "tracking packet contains no registered player"));
  }
  latest_observation_sequence_[observation.node] = observation.sequence;
  for (const auto &player : observation.players) {
    if (state_.players.find(player.player_id) != state_.players.end()) {
      observations_[observation.node][player.player_id] =
          StoredObservation{player, observation.sequence};
    }
  }

  update_fused_positions(now_ms);
  ActionResult result = accept("tracking observation recorded");
  publish();
  result.state_version = state_.version;
  return result;
}

ActionResult
MasterEngine::receive_heartbeat(const protocol::WorkerHeartbeat &heartbeat,
                                std::uint64_t now_ms) {
  bool time_state_changed = state_.now_ms != now_ms;
  state_.now_ms = now_ms;
  time_state_changed = set_health_for_time(now_ms) || time_state_changed;
  time_state_changed = update_fused_positions(now_ms) || time_state_changed;
  auto reject_with_time_update = [&](ActionResult result) {
    if (time_state_changed) {
      publish();
      result.state_version = state_.version;
    }
    return result;
  };
  if (heartbeat.node.empty() || !std::isfinite(heartbeat.fps) ||
      heartbeat.fps < 0.0 || heartbeat.fps > 1000.0) {
    return reject_with_time_update(
        reject(ActionCode::InvalidHeartbeat, "invalid worker heartbeat"));
  }
  auto health_it = state_.workers.find(heartbeat.node);
  if (health_it == state_.workers.end()) {
    return reject_with_time_update(
        reject(ActionCode::InvalidHeartbeat, "worker is not configured"));
  }
  if (health_it->second.has_heartbeat &&
      heartbeat.sequence <= health_it->second.last_heartbeat_sequence) {
    return reject_with_time_update(
        reject(ActionCode::StaleObservation,
               "older worker heartbeat cannot replace current health"));
  }

  WorkerHealth &health = health_it->second;
  health.has_heartbeat = true;
  health.last_heartbeat_received_ms = now_ms;
  health.last_heartbeat_sequence = heartbeat.sequence;
  health.fps = heartbeat.fps;
  health.state = heartbeat.camera_healthy && heartbeat.inference_healthy
                     ? HealthState::Healthy
                     : HealthState::Failed;
  update_fused_positions(now_ms);
  ActionResult result =
      accept(health.state == HealthState::Healthy ? "worker heartbeat healthy"
                                                  : "worker reported failed",
             false);
  publish();
  result.state_version = state_.version;
  return result;
}

ActionResult
MasterEngine::receive_gateway_status(const protocol::GatewayStatus &status,
                                     std::uint64_t now_ms) {
  state_.now_ms = now_ms;
  set_health_for_time(now_ms);
  state_.gateway.packet_count = status.packet_count;
  state_.gateway.dropped_count = status.dropped_count;
  if (status.up) {
    state_.gateway.state = HealthState::Healthy;
    state_.gateway.last_received_ms = now_ms;
  } else {
    state_.gateway.state = HealthState::Failed;
  }
  ActionResult result =
      accept(status.up ? "gateway healthy" : "gateway reported down");
  publish();
  result.state_version = state_.version;
  return result;
}

void MasterEngine::tick(std::uint64_t now_ms) {
  const bool time_changed = state_.now_ms != now_ms;
  state_.now_ms = now_ms;
  bool changed = set_health_for_time(now_ms);
  changed = update_fused_positions(now_ms) || changed;

  for (auto &[station_kind, station] : state_.stations) {
    (void)station_kind;
    if (station.processing != ProcessingState::Idle &&
        station.processing_deadline_ms <= now_ms) {
      changed = true;
    }
  }
  complete_processing(now_ms);

  if (state_.phase == GamePhase::Running && state_.order.active &&
      state_.order.deadline_ms <= now_ms) {
    state_.order.active = false;
    state_.order.expired = true;
    state_.phase = GamePhase::Expired;
    changed = true;
  }
  if (changed || state_.version == 0 || time_changed) {
    publish();
  }
}

HealthState MasterEngine::worker_state(std::string_view node) const {
  const auto found = state_.workers.find(std::string(node));
  return found == state_.workers.end() ? HealthState::Unknown
                                       : found->second.state;
}

const char *to_string(GamePhase phase) {
  switch (phase) {
  case GamePhase::Idle:
    return "IDLE";
  case GamePhase::Running:
    return "RUNNING";
  case GamePhase::Completed:
    return "COMPLETED";
  case GamePhase::Expired:
    return "EXPIRED";
  }
  return "UNKNOWN";
}

const char *to_string(Item item) {
  switch (item) {
  case Item::Empty:
    return "EMPTY";
  case Item::RawTomato:
    return "RAW_TOMATO";
  case Item::ChoppedTomato:
    return "CHOPPED_TOMATO";
  case Item::CookedSoup:
    return "COOKED_SOUP";
  case Item::SoupPlate:
    return "SOUP_PLATE";
  }
  return "UNKNOWN";
}

const char *to_string(StationKind station) {
  switch (station) {
  case StationKind::None:
    return "NONE";
  case StationKind::TomatoSource:
    return "TOMATO_SOURCE";
  case StationKind::Chopping:
    return "CHOPPING";
  case StationKind::Pot:
    return "POT";
  case StationKind::Plate:
    return "PLATE";
  case StationKind::Delivery:
    return "DELIVERY";
  }
  return "UNKNOWN";
}

const char *to_string(ProcessingState processing) {
  switch (processing) {
  case ProcessingState::Idle:
    return "IDLE";
  case ProcessingState::Chopping:
    return "CHOPPING";
  case ProcessingState::Cooking:
    return "COOKING";
  }
  return "UNKNOWN";
}

const char *to_string(HealthState health) {
  switch (health) {
  case HealthState::Unknown:
    return "UNKNOWN";
  case HealthState::Healthy:
    return "HEALTHY";
  case HealthState::Failed:
    return "FAILED";
  case HealthState::Stale:
    return "STALE";
  }
  return "UNKNOWN";
}

const char *to_string(ActionCode code) {
  switch (code) {
  case ActionCode::Accepted:
    return "ACCEPTED";
  case ActionCode::Completed:
    return "COMPLETED";
  case ActionCode::Duplicate:
    return "DUPLICATE";
  case ActionCode::Malformed:
    return "MALFORMED";
  case ActionCode::UnknownBadge:
    return "UNKNOWN_BADGE";
  case ActionCode::NotRunning:
    return "NOT_RUNNING";
  case ActionCode::UnsupportedIntent:
    return "UNSUPPORTED_INTENT";
  case ActionCode::StaleOrLowConfidence:
    return "STALE_OR_LOW_CONFIDENCE";
  case ActionCode::InvalidState:
    return "INVALID_STATE";
  case ActionCode::ExpiredOrder:
    return "EXPIRED_ORDER";
  case ActionCode::InvalidObservation:
    return "INVALID_OBSERVATION";
  case ActionCode::StaleObservation:
    return "STALE_OBSERVATION";
  case ActionCode::InvalidHeartbeat:
    return "INVALID_HEARTBEAT";
  }
  return "UNKNOWN";
}

} // namespace htn26::master
