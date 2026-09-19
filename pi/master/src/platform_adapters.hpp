#pragma once

#include "master_engine.hpp"

#include <cstdint>
#include <optional>
#include <string>

namespace htn26::master {

// QNX-specific code belongs outside the authoritative core. A QNX adapter can
// implement these small ports using /dev/ser*, camera/network APIs, and a
// monotonic clock, then feed the results to MasterEngine. The core remains
// portable and testable on a workstation.
class MonotonicClock {
public:
  virtual ~MonotonicClock() = default;
  virtual std::uint64_t now_ms() const = 0;
};

class GatewaySerialSource {
public:
  virtual ~GatewaySerialSource() = default;
  virtual std::optional<std::string> read_line() = 0;
};

class WorkerObservationSource {
public:
  virtual ~WorkerObservationSource() = default;
  virtual std::optional<protocol::WorkerObservation> read_observation() = 0;
  virtual std::optional<protocol::WorkerHeartbeat> read_heartbeat() = 0;
};

class StatePublisher {
public:
  virtual ~StatePublisher() = default;
  virtual void publish(const GameState &state) = 0;
};

// An adapter loop should follow this order without putting device work in the
// game rules: drain bounded serial/worker inputs, call tick(clock.now_ms()),
// then publish the resulting immutable snapshot to the UI adapter.
} // namespace htn26::master
