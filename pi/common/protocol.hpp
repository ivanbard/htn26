#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace htn26::protocol {

// The badge radio payload is limited by the badge runtime. Keep this limit in
// the shared contract so gateway and master implementations cannot drift.
constexpr std::size_t kMaxBadgePayloadBytes = 44;
constexpr std::uint32_t kMaxBadgeSequence = 0xffffffffu;

struct BadgeIntent {
  std::string sender_mac;  // Canonical upper-case AA:BB:CC:DD:EE:FF.
  int rssi = 0;
  std::uint32_t sequence = 0;
  char type = '\0';
  std::string value;
};

struct ParseResult {
  bool ok = false;
  BadgeIntent intent;
  std::string error;
};

struct GatewayStatus {
  bool up = false;
  std::uint64_t packet_count = 0;
  std::uint64_t dropped_count = 0;
};

struct GatewayStatusParseResult {
  bool ok = false;
  GatewayStatus status;
  std::string error;
};

// Parses a noisy serial line by finding HTN26| anywhere in the line. The
// returned MAC is normalized, which makes mapping and deduplication stable.
ParseResult parse_gateway_rx_line(std::string_view line);
GatewayStatusParseResult parse_gateway_status_line(std::string_view line);

bool is_valid_mac(std::string_view mac);
std::string normalize_mac(std::string_view mac);

struct PlayerObservation {
  int player_id = 0;
  double x = 0.0;
  double y = 0.0;
  double confidence = 0.0;
  std::uint64_t timestamp_ms = 0;
};

// Tracking is replaceable telemetry, not an event log. A newer sequence from
// a node supersedes an older observation rather than being queued forever.
struct WorkerObservation {
  std::string node;
  std::uint64_t sequence = 0;
  std::uint64_t timestamp_ms = 0;
  std::vector<PlayerObservation> players;
};

struct WorkerHeartbeat {
  std::string node;
  std::uint64_t sequence = 0;
  std::uint64_t reported_timestamp_ms = 0;
  bool camera_healthy = false;
  bool inference_healthy = false;
  double fps = 0.0;
};

}  // namespace htn26::protocol
