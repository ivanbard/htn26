#include "master_engine.hpp"

#include <atomic>
#include <chrono>
#include <deque>
#include <fstream>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>

namespace {

std::uint64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
      .count();
}

void print_state(const htn26::master::GameState &state) {
  std::cout << "STATE version=" << state.version
            << " phase=" << htn26::master::to_string(state.phase)
            << " score=" << state.score
            << " gateway=" << htn26::master::to_string(state.gateway.state)
            << " packets=" << state.gateway.packet_count
            << " dropped=" << state.gateway.dropped_count << '\n';
}

void process_line(htn26::master::MasterEngine &engine,
                  const std::string &line) {
  const auto result = engine.ingest_serial_line(line, now_ms());
  std::cout << "EVENT code=" << htn26::master::to_string(result.code)
            << " accepted=" << (result.accepted ? "yes" : "no")
            << " detail=" << result.detail << '\n';
}

} // namespace

int main(int argc, char **argv) {
  if (argc < 2 || argc > 3) {
    std::cerr << "usage: " << argv[0] << " BADGE_MAC [INPUT_DEVICE]\n";
    return 2;
  }

  std::ifstream device;
  std::istream *input = &std::cin;
  if (argc == 3 && std::string(argv[2]) != "-") {
    device.open(argv[2]);
    if (!device) {
      std::cerr << "cannot open input device: " << argv[2] << '\n';
      return 1;
    }
    input = &device;
  }

  htn26::master::MasterEngine engine;
  if (!engine.register_badge(argv[1], 1)) {
    std::cerr << "invalid badge MAC: " << argv[1] << '\n';
    return 2;
  }
  engine.set_state_listener(print_state);
  engine.start_game(now_ms());

  std::cout << "READY badge=" << argv[1]
            << " input=" << (argc == 3 ? argv[2] : "stdin") << '\n';

  std::mutex input_mutex;
  std::deque<std::string> lines;
  std::atomic<bool> input_done{false};
  std::thread reader([&] {
    std::string line;
    while (std::getline(*input, line)) {
      std::lock_guard<std::mutex> lock(input_mutex);
      if (lines.size() == 256)
        lines.pop_front();
      lines.push_back(std::move(line));
    }
    input_done = true;
  });

  for (;;) {
    std::deque<std::string> ready;
    {
      std::lock_guard<std::mutex> lock(input_mutex);
      ready.swap(lines);
    }
    for (const auto &line : ready)
      process_line(engine, line);
    engine.tick(now_ms());
    if (input_done && ready.empty())
      break;
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }

  reader.join();
  if (input->bad()) {
    std::cerr << "input read failed\n";
    return 1;
  }
  return 0;
}
