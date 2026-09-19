#include "master_engine.hpp"
#include "platform_adapters.hpp"

#include "pi/common/protocol.hpp"

#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using htn26::master::ActionCode;
using htn26::master::GamePhase;
using htn26::master::GameState;
using htn26::master::HealthState;
using htn26::master::Item;
using htn26::master::MasterConfig;
using htn26::master::MasterEngine;
using htn26::master::ProcessingState;
using htn26::master::StationKind;
using htn26::protocol::PlayerObservation;
using htn26::protocol::WorkerHeartbeat;
using htn26::protocol::WorkerObservation;

void require(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

std::string rx(unsigned sequence, char type, const std::string& value) {
  return std::string("serial-prefix HTN26|RX|aa:bb:cc:dd:ee:ff|-53|OC1|") +
         (sequence < 10 ? "000" : sequence < 100 ? "00" : sequence < 1000 ? "0" : "") +
         std::to_string(sequence) + "|" + type + "|" + value + "\r\n";
}

MasterConfig test_config() {
  MasterConfig config = MasterConfig::defaults();
  config.position_stale_ms = 500;
  config.worker_stale_ms = 1000;
  config.gateway_stale_ms = 1500;
  config.chopping_duration_ms = 100;
  config.cooking_duration_ms = 200;
  config.order_duration_ms = 5000;
  config.minimum_position_confidence = 0.8;
  config.worker_nodes = {"cam1", "pi2"};
  return config;
}

void test_protocol_validation() {
  const auto parsed = htn26::protocol::parse_gateway_rx_line(
      "[gateway] INFO HTN26|RX|aa:bb:cc:dd:ee:ff|-53|OC1|0042|N|ING:TOM\n");
  require(parsed.ok, "noisy serial RX line should parse");
  require(parsed.intent.sender_mac == "AA:BB:CC:DD:EE:FF",
          "MAC should be normalized");
  require(parsed.intent.sequence == 42 && parsed.intent.type == 'N' &&
              parsed.intent.value == "ING:TOM",
          "parsed badge fields should match");

  require(!htn26::protocol::parse_gateway_rx_line(
                "HTN26|RX|AA:BB:CC:DD:EE:FF|-53|OC2|0042|N|ING:TOM")
                .ok,
          "unsupported protocol must be rejected");
  require(!htn26::protocol::parse_gateway_rx_line(
                "HTN26|RX|not-a-mac|-53|OC1|0042|N|ING:TOM")
                .ok,
          "invalid MAC must be rejected");
  require(!htn26::protocol::parse_gateway_rx_line(
                "HTN26|RX|AA:BB:CC:DD:EE:FF|-53|OC1|0042|N|bad|extra")
                .ok,
          "extra fields must be rejected");

  const auto status = htn26::protocol::parse_gateway_status_line(
      "log HTN26|GW|UP|1842|0\r\n");
  require(status.ok && status.status.up && status.status.packet_count == 1842,
          "gateway status should parse");
}

void test_complete_tomato_soup_flow_and_dedup() {
  MasterEngine engine(test_config());
  const std::string mac = "AA:BB:CC:DD:EE:FF";
  require(engine.register_badge(mac, 1), "badge should register");
  std::vector<std::uint64_t> published_versions;
  engine.set_state_listener([&](const auto& snapshot) {
    published_versions.push_back(snapshot.version);
  });
  require(engine.start_game(0), "game should start");
  require(engine.receive_heartbeat(
              WorkerHeartbeat{"cam1", 1, 0, true, true, 8.0}, 0)
              .accepted,
          "healthy worker heartbeat should be accepted");

  require(engine.receive_tracking(
              WorkerObservation{"cam1", 1, 0, {{1, 0.5, 0.5, 0.95, 0}}}, 0)
              .accepted,
          "source observation should be accepted");
  auto result = engine.ingest_serial_line(rx(1, 'N', "ING:TOM"), 0);
  require(result.accepted && result.code == ActionCode::Accepted,
          "tomato intent should be accepted at source");
  require(engine.state().players.at(1).held_item == Item::RawTomato,
          "player should hold raw tomato");

  result = engine.ingest_serial_line(rx(1, 'N', "ING:TOM"), 1);
  require(!result.accepted && result.code == ActionCode::Duplicate,
          "retransmitted sequence must be suppressed");
  require(engine.state().players.at(1).held_item == Item::RawTomato,
          "duplicate must not apply a second action");

  require(engine.receive_tracking(
              WorkerObservation{"cam1", 2, 2, {{1, 1.5, 0.5, 0.95, 2}}}, 2)
              .accepted,
          "chopping observation should be accepted");
  require(engine.ingest_serial_line(rx(2, 'N', "STN:CHOP1"), 2).accepted,
          "chopping station intent should be accepted");
  require(engine.ingest_serial_line(rx(3, 'M', "CHOP"), 3).accepted,
          "chop motion should start timer");
  require(engine.state().stations.at(StationKind::Chopping).processing ==
              ProcessingState::Chopping,
          "chopping timer should be running");
  engine.tick(103);
  require(engine.state().players.at(1).held_item == Item::ChoppedTomato,
          "chopping timer should produce chopped tomato");

  require(engine.receive_tracking(
              WorkerObservation{"cam1", 3, 104, {{1, 2.5, 0.5, 0.95, 104}}}, 104)
              .accepted,
          "pot observation should be accepted");
  require(engine.ingest_serial_line(rx(4, 'N', "STN:POT1"), 104).accepted,
          "pot intent should be accepted");
  require(engine.state().stations.at(StationKind::Pot).processing ==
              ProcessingState::Cooking,
          "cooking timer should be running");
  engine.tick(305);
  require(engine.state().stations.at(StationKind::Pot).contents == Item::CookedSoup,
          "cooking timer should produce cooked soup");

  require(engine.receive_tracking(
              WorkerObservation{"cam1", 4, 306, {{1, 3.5, 0.5, 0.95, 306}}}, 306)
              .accepted,
          "plate observation should be accepted");
  require(engine.ingest_serial_line(rx(5, 'N', "STN:PLATE"), 306).accepted,
          "plate intent should be accepted");
  require(engine.state().players.at(1).held_item == Item::SoupPlate,
          "player should hold plated soup");

  require(engine.receive_tracking(
              WorkerObservation{"cam1", 5, 307, {{1, 4.5, 0.5, 0.95, 307}}}, 307)
              .accepted,
          "delivery observation should be accepted");
  result = engine.ingest_serial_line(rx(6, 'N', "STN:DELIVERY"), 307);
  require(result.accepted && result.code == ActionCode::Completed,
          "delivery should complete the order");
  require(engine.state().phase == GamePhase::Completed &&
              engine.state().score == 100 && engine.state().order.completed,
          "authoritative score and order state should be updated once");
  require(!published_versions.empty(), "state snapshots should be published");
  for (std::size_t index = 1; index < published_versions.size(); ++index) {
    require(published_versions[index] > published_versions[index - 1],
            "published state versions must be monotonic");
  }
}

void test_location_bounds_and_worker_failure() {
  MasterEngine engine(test_config());
  require(engine.register_badge("AA:BB:CC:DD:EE:FF", 1), "badge should register");
  engine.start_game(0);
  require(engine.receive_heartbeat(
              WorkerHeartbeat{"cam1", 1, 0, true, true, 8.0}, 0)
              .accepted,
          "worker should become healthy");
  require(engine.receive_tracking(
              WorkerObservation{"cam1", 1, 0, {{1, 0.5, 0.5, 0.95, 0}}}, 0)
              .accepted,
          "fresh source observation should be accepted");
  require(engine.ingest_serial_line(rx(1, 'N', "ING:TOM"), 0).accepted,
          "initial source action should be accepted");

  engine.tick(1001);
  require(engine.worker_state("cam1") == HealthState::Stale,
          "worker must become stale after heartbeat timeout");
  auto result = engine.ingest_serial_line(rx(2, 'N', "STN:CHOP1"), 1001);
  require(!result.accepted && result.code == ActionCode::StaleOrLowConfidence,
          "stale tracking must reject location-sensitive intent");

  result = engine.receive_heartbeat(
      WorkerHeartbeat{"cam1", 2, 1002, false, false, 0.0}, 1002);
  require(result.accepted && engine.worker_state("cam1") == HealthState::Failed,
          "explicit worker failure must be represented without crashing");
  result = engine.receive_heartbeat(
      WorkerHeartbeat{"cam1", 3, 1003, true, true, 7.0}, 1003);
  require(result.accepted && engine.worker_state("cam1") == HealthState::Healthy,
          "worker should recover on a newer healthy heartbeat");

  require(engine.receive_tracking(
              WorkerObservation{"cam1", 2, 1003, {{1, 1.5, 0.5, 0.5, 1003}}}, 1003)
              .accepted,
          "low-confidence telemetry is still recorded as telemetry");
  result = engine.ingest_serial_line(rx(3, 'N', "STN:CHOP1"), 1003);
  require(!result.accepted && result.code == ActionCode::StaleOrLowConfidence,
          "low-confidence location must be rejected");

  require(engine.receive_gateway_status(
              htn26::protocol::GatewayStatus{true, 1, 0}, 1003)
              .accepted,
          "gateway status should be accepted");
  engine.tick(2504);
  require(engine.state().gateway.state == HealthState::Stale,
          "gateway must become stale when status/RX disappears");
}

void test_tracking_rejection_and_health_publication() {
  MasterEngine engine(test_config());
  require(engine.receive_heartbeat(
              WorkerHeartbeat{"cam1", 1, 0, true, true, 8.0}, 0)
              .accepted,
          "worker should become healthy");

  const auto unknown = engine.receive_tracking(
      WorkerObservation{"cam1", 7, 1, {{99, 0.5, 0.5, 0.95, 1}}}, 1);
  require(unknown.code == ActionCode::InvalidObservation,
          "unknown-player tracking should be rejected");
  require(engine.register_badge("AA:BB:CC:DD:EE:FF", 1),
          "badge should register after unknown tracking");
  require(engine.receive_tracking(
              WorkerObservation{"cam1", 7, 2, {{1, 0.5, 0.5, 0.95, 2}}}, 2)
              .accepted,
          "the same sequence should remain available to a newly registered player");

  GameState published;
  engine.set_state_listener([&](const auto& snapshot) { published = snapshot; });
  const auto invalid = engine.receive_tracking(
      WorkerObservation{"cam1", 8, 1001, {{1, 0.5, 0.5, 2.0, 1001}}}, 1001);
  require(invalid.code == ActionCode::InvalidObservation,
          "invalid tracking should be rejected");
  require(engine.worker_state("cam1") == HealthState::Stale &&
              published.workers.at("cam1").state == HealthState::Stale,
          "health transitions must be published with rejected input");
}

void test_default_station_boundaries_do_not_overlap() {
  MasterEngine engine(test_config());
  require(engine.register_badge("AA:BB:CC:DD:EE:FF", 1), "badge should register");
  engine.start_game(0);
  require(engine.receive_heartbeat(
              WorkerHeartbeat{"cam1", 1, 0, true, true, 8.0}, 0)
              .accepted,
          "worker should become healthy");
  require(engine.receive_tracking(
              WorkerObservation{"cam1", 1, 0, {{1, 1.0, 0.5, 0.95, 0}}}, 0)
              .accepted,
          "boundary observation should be accepted");
  require(!engine.player_is_at(1, StationKind::TomatoSource, 0),
          "left station must not include its upper boundary");
  require(engine.player_is_at(1, StationKind::Chopping, 0),
          "right station must own its lower boundary");
}

void test_order_timer_and_invalid_inputs() {
  MasterConfig config = test_config();
  config.order_duration_ms = 10;
  MasterEngine engine(config);
  require(engine.register_badge("AA:BB:CC:DD:EE:FF", 1), "badge should register");
  engine.start_game(0);
  engine.tick(11);
  require(engine.state().phase == GamePhase::Expired &&
              engine.state().order.expired && !engine.state().order.active,
          "order timer must deterministically expire the order");
  const auto result = engine.ingest_serial_line(rx(1, 'N', "ING:TOM"), 11);
  require(!result.accepted && result.code == ActionCode::ExpiredOrder,
          "expired order must reject further gameplay");
  require(engine.ingest_serial_line("noise without protocol", 12).code ==
              ActionCode::Malformed,
          "malformed serial input must not crash or mutate gameplay");
}

}  // namespace

int main() {
  try {
    test_protocol_validation();
    test_complete_tomato_soup_flow_and_dedup();
    test_location_bounds_and_worker_failure();
    test_tracking_rejection_and_health_publication();
    test_default_station_boundaries_do_not_overlap();
    test_order_timer_and_invalid_inputs();
  } catch (const std::exception& error) {
    std::cerr << "FAIL: " << error.what() << '\n';
    return 1;
  }
  std::cout << "PASS: protocol, tomato soup flow, deduplication, timers, location bounds, and worker health\n";
  return 0;
}
