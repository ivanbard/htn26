#include "htn26/worker_core.hpp"

#include <chrono>
#include <iostream>

using namespace htn26::slave;
using namespace std::chrono_literals;

int main() {
  // Host Start normally produces this calibration from an approved room scan
  // on the serving-area master. The demo substitutes a synthetic floor plan.
  const Calibration simulated_approved_room_scan =
      Calibration{Homography{{1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0}}};

  WorkerConfig config;
  config.node_id = "field-worker-demo";
  config.camera_id = "field-camera-demo";
  config.calibration = simulated_approved_room_scan;
  // Synthetic visible marker 7 represents player 1 for this host-only demo.
  config.marker_to_player.emplace(7, 1);

  WorkerCore worker(config);
  const TimePoint now{};
  const auto observation = worker.process_detections(
      now, {Detection{3, ImagePoint{2.5, 1.25}, 0.95, true, 7}}, 8ms);
  const auto heartbeat = worker.heartbeat_if_due(now);

  if (!observation || !heartbeat)
    return 1;
  std::cout << "room_scan=simulated-approved-floor-plan"
            << " marker=simulated-7->player-1"
            << " node=" << heartbeat->node_id
            << " sequence=" << observation->sequence
            << " players=" << observation->players.size() << " world=("
            << observation->players.front().position.x << ","
            << observation->players.front().position.y << ")\n";
  return 0;
}
