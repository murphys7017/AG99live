#include "ag99/runtime/segment_assembler.hpp"

#include <utility>

namespace ag99::runtime {

SegmentAssembler::IngestResult SegmentAssembler::ingest(OutputSegment segment) {
  if (!segment.envelope.turn_id.has_value()) {
    return {false, "segment_turn_id_missing", {}};
  }
  const auto turn_id = *segment.envelope.turn_id;
  const auto& message_id = segment.envelope.message_id;
  if (message_id.empty()) {
    return {false, "segment_message_id_missing", {}};
  }
  if (committed_message_ids_.contains(message_id)) {
    return {false, "segment_duplicate_committed", {}};
  }

  auto& turn = turns_[turn_id];
  if (turn.message_ids.contains(message_id)) {
    return {false, "segment_duplicate_pending", {}};
  }
  if (segment.sequence < turn.next_sequence) {
    return {false, "segment_sequence_late", {}};
  }
  if (turn.pending.contains(segment.sequence)) {
    return {false, "segment_sequence_conflict", {}};
  }

  turn.message_ids.emplace(message_id);
  turn.pending.emplace(segment.sequence, std::move(segment));

  std::vector<OutputSegment> ready;
  while (true) {
    const auto it = turn.pending.find(turn.next_sequence);
    if (it == turn.pending.end()) {
      break;
    }
    ready.push_back(std::move(it->second));
    committed_message_ids_.emplace(ready.back().envelope.message_id);
    turn.pending.erase(it);
    ++turn.next_sequence;
  }
  return {true, {}, std::move(ready)};
}

void SegmentAssembler::clear_turn(std::string_view turn_id) {
  turns_.erase(std::string(turn_id));
}

void SegmentAssembler::clear_all() {
  turns_.clear();
  committed_message_ids_.clear();
}

}  // namespace ag99::runtime
