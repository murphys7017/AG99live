#pragma once

#include <cstdint>
#include <deque>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "ag99/runtime/protocol.hpp"

namespace ag99::runtime {

class SegmentAssembler final {
 public:
  struct IngestResult {
    bool accepted = false;
    std::string reason;
    std::vector<OutputSegment> ready;
  };

  bool start_turn(std::string_view turn_id);
  IngestResult ingest(OutputSegment segment);
  bool mark_synthesis_finished(std::string_view turn_id);
  // Cancels output while retaining the turn for the backend terminal signal.
  bool interrupt_turn(std::string_view turn_id);
  // Retires the turn and rejects late output during the bounded completion window.
  bool clear_turn(std::string_view turn_id);
  void clear_all();

 private:
  struct TurnState {
    std::int64_t next_sequence = 0;
    bool synthesis_finished = false;
    bool interrupted = false;
    std::map<std::int64_t, OutputSegment> pending;
    std::unordered_set<std::string> pending_message_ids;
  };

  std::unordered_map<std::string, TurnState> turns_;
  std::unordered_set<std::string> committed_message_ids_;
  std::deque<std::string> committed_message_id_order_;
  std::unordered_set<std::string> completed_turn_ids_;
  std::deque<std::string> completed_turn_id_order_;
};

}  // namespace ag99::runtime
