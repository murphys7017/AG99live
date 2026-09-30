#pragma once

#include <cstdint>
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

  IngestResult ingest(OutputSegment segment);
  void clear_turn(std::string_view turn_id);
  void clear_all();

 private:
  struct TurnState {
    std::int64_t next_sequence = 0;
    std::map<std::int64_t, OutputSegment> pending;
    std::unordered_set<std::string> message_ids;
  };

  std::unordered_map<std::string, TurnState> turns_;
  std::unordered_set<std::string> committed_message_ids_;
};

}  // namespace ag99::runtime
