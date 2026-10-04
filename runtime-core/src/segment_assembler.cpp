#include "ag99/runtime/segment_assembler.hpp"

#include <utility>

namespace ag99::runtime {
namespace {

constexpr std::size_t kMaxTrackedTurns = 128;
constexpr std::size_t kMaxPendingSegmentsPerTurn = 256;
constexpr std::size_t kMaxRememberedCommittedMessageIds = 8192;
constexpr std::size_t kMaxRememberedCompletedTurnIds = 1024;

}  // namespace

bool SegmentAssembler::start_turn(std::string_view turn_id) {
  const std::string id(turn_id);
  if (id.empty() || completed_turn_ids_.contains(id)) {
    return false;
  }
  if (turns_.contains(id)) {
    return false;
  }
  if (turns_.size() >= kMaxTrackedTurns) {
    return false;
  }
  turns_.try_emplace(id);
  return true;
}

SegmentAssembler::IngestResult SegmentAssembler::ingest(OutputSegment segment) {
  if (!segment.envelope.turn_id.has_value()) {
    return {false, "segment_turn_id_missing", {}};
  }
  const auto turn_id = *segment.envelope.turn_id;
  const auto& message_id = segment.envelope.message_id;
  if (message_id.empty()) {
    return {false, "segment_message_id_missing", {}};
  }
  if (completed_turn_ids_.contains(turn_id)) {
    return {false, "segment_turn_finished", {}};
  }
  if (committed_message_ids_.contains(message_id)) {
    return {false, "segment_duplicate_committed", {}};
  }

  auto turn_it = turns_.find(turn_id);
  if (turn_it == turns_.end()) {
    return {false, "segment_turn_not_started", {}};
  }
  auto& turn = turn_it->second;
  if (turn.pending_message_ids.contains(message_id)) {
    return {false, "segment_duplicate_pending", {}};
  }
  if (segment.sequence < turn.next_sequence) {
    return {false, "segment_sequence_late", {}};
  }
  if (turn.pending.contains(segment.sequence)) {
    return {false, "segment_sequence_conflict", {}};
  }
  if (turn.pending.size() >= kMaxPendingSegmentsPerTurn
      && segment.sequence != turn.next_sequence) {
    return {false, "segment_pending_limit", {}};
  }

  turn.pending_message_ids.emplace(message_id);
  turn.pending.emplace(segment.sequence, std::move(segment));

  std::vector<OutputSegment> ready;
  while (true) {
    const auto it = turn.pending.find(turn.next_sequence);
    if (it == turn.pending.end()) {
      break;
    }
    ready.push_back(std::move(it->second));
    const auto& committed_id = ready.back().envelope.message_id;
    turn.pending_message_ids.erase(committed_id);
    if (committed_message_ids_.emplace(committed_id).second) {
      committed_message_id_order_.push_back(committed_id);
      if (committed_message_id_order_.size()
          > kMaxRememberedCommittedMessageIds) {
        committed_message_ids_.erase(committed_message_id_order_.front());
        committed_message_id_order_.pop_front();
      }
    }
    turn.pending.erase(it);
    ++turn.next_sequence;
  }
  return {true, {}, std::move(ready)};
}

bool SegmentAssembler::clear_turn(std::string_view turn_id) {
  std::string completed_id(turn_id);
  if (completed_id.empty() || turns_.erase(completed_id) == 0
      || !completed_turn_ids_.emplace(completed_id).second) {
    return false;
  }
  completed_turn_id_order_.push_back(std::move(completed_id));
  if (completed_turn_id_order_.size() > kMaxRememberedCompletedTurnIds) {
    completed_turn_ids_.erase(completed_turn_id_order_.front());
    completed_turn_id_order_.pop_front();
  }
  return true;
}

void SegmentAssembler::clear_all() {
  turns_.clear();
  committed_message_ids_.clear();
  committed_message_id_order_.clear();
  completed_turn_ids_.clear();
  completed_turn_id_order_.clear();
}

}  // namespace ag99::runtime
