#pragma once

#include <optional>
#include <mutex>
#include <cstdint>
#include <limits>
#include <string>
#include <unordered_map>

#include "ag99/runtime/protocol.hpp"

namespace ag99::native {

class DesktopPresenceRuntime final {
 public:
  DesktopPresenceRuntime();

  std::optional<ag99::runtime::Json> Read(
      const ag99::runtime::DesktopPresenceRequest& request,
      std::string& error);

 private:
  struct State {
    int idle_after_seconds = 300;
    int minimum_away_seconds = 60;
    int confirmation_seconds = 3;
    bool initialized = false;
    bool armed = false;
    double previous_input_ms = -std::numeric_limits<double>::infinity();
    struct Away {
      std::string basis;
      double since_ms = 0.0;
      bool eligible = false;
    };
    struct Candidate {
      double since_ms = 0.0;
      double input_at_ms = 0.0;
      int inactive_seconds = 0;
    };
    struct Returned {
      std::string event_id;
      std::string basis;
      int inactive_seconds = 0;
      double at_ms = 0.0;
    };
    std::optional<Away> away;
    std::optional<Candidate> candidate;
    std::optional<Returned> returned;
    std::uint64_t sequence = 0;
    std::string identity;
  };

  static bool IsInputBlocked();
  static double NowMilliseconds();
  ag99::runtime::Json Snapshot(
      const State& state,
      double now_ms,
      std::string_view status) const;

  std::string boot_id_;
  std::unordered_map<std::string, State> states_;
  std::mutex mutex_;
};

}  // namespace ag99::native
