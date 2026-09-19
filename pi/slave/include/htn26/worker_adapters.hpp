#pragma once

#include "htn26/worker_core.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace htn26::slave {

/**
 * Result returned by a platform adapter.  The worker only needs the boolean;
 * detail is for diagnostics and is deliberately not interpreted by the core.
 */
struct AdapterResult {
  bool ok = false;
  std::string detail;
};

/**
 * Opaque camera frame boundary.  A QNX implementation may put a native
 * capture handle in native_handle; portable code never dereferences it.
 */
struct CameraFrame {
  std::uint64_t sequence = 0;
  TimePoint captured_at{};
  const void* native_handle = nullptr;
};

class CameraAdapter {
 public:
  virtual ~CameraAdapter() = default;
  virtual AdapterResult initialize() = 0;
  virtual AdapterResult capture(CameraFrame& frame) = 0;
  virtual void shutdown() = 0;
};

struct InferenceResult {
  bool ok = false;
  std::vector<Detection> detections;
  Duration latency{};
  std::string detail;
};

/**
 * Narrow seam for the qualifying on-device QNX AI module.  No module,
 * version, or source is assumed here; an integration supplies this adapter
 * after verifying the QNX qualification requirement.
 */
class InferenceAdapter {
 public:
  virtual ~InferenceAdapter() = default;
  virtual AdapterResult initialize() = 0;
  virtual InferenceResult infer(const CameraFrame& frame,
                                TimePoint now) = 0;
  virtual void shutdown() = 0;
};

/** Reliable or best-effort transport selected by the deployment. */
class MasterTransport {
 public:
  virtual ~MasterTransport() = default;
  virtual bool send_tracking(const TrackingObservation& observation) = 0;
  virtual bool send_heartbeat(const Heartbeat& heartbeat) = 0;
};

/**
 * Small orchestration seam used by a real QNX process and by host fakes.  It
 * deliberately has no camera, AI, socket, or QNX headers of its own.
 */
class WorkerRuntime {
 public:
  WorkerRuntime(WorkerCore& core, CameraAdapter& camera,
                InferenceAdapter& inference, MasterTransport& master);

  bool start();
  bool run_once(TimePoint now);
  void shutdown();

 private:
  WorkerCore& core_;
  CameraAdapter& camera_;
  InferenceAdapter& inference_;
  MasterTransport& master_;
  bool started_ = false;
};

}  // namespace htn26::slave
