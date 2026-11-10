#include "ag99/runtime/incremental_output_assembler.hpp"

#include <algorithm>
#include <limits>
#include <ranges>
#include <utility>

namespace ag99::runtime {
namespace {

constexpr std::size_t kMaxTrackedTurns = 128;
constexpr std::size_t kMaxSegmentsPerTurn = 256;
constexpr std::size_t kMaxSegmentTextUnits = 65536;
constexpr std::size_t kMaxTurnTextUnits = 262144;
constexpr std::size_t kMaxRememberedCompletedTurnIds = 1024;
constexpr std::uint64_t kMaxJavaScriptSafeInteger = 9007199254740991ULL;

}  // namespace

std::size_t IncrementalOutputAssembler::resource_index(
    IncrementalOutputResource resource) {
  switch (resource) {
    case IncrementalOutputResource::Text:
      return 0;
    case IncrementalOutputResource::Audio:
      return 1;
    case IncrementalOutputResource::Motion:
      return 2;
  }
  return 0;
}

bool IncrementalOutputAssembler::is_terminal(StreamStatus status) {
  return status != StreamStatus::Open;
}

IncrementalOutputAssembler::StreamStatus
IncrementalOutputAssembler::status_for(IncrementalOutputStatus status) {
  switch (status) {
    case IncrementalOutputStatus::Completed:
      return StreamStatus::Completed;
    case IncrementalOutputStatus::Failed:
      return StreamStatus::Failed;
    case IncrementalOutputStatus::Cancelled:
      return StreamStatus::Cancelled;
  }
  return StreamStatus::Failed;
}

std::size_t IncrementalOutputAssembler::utf16_length(std::string_view value) {
  std::size_t length = 0;
  for (std::size_t offset = 0; offset < value.size();) {
    const auto byte = static_cast<unsigned char>(value[offset++]);
    if (byte < 0x80) {
      ++length;
      continue;
    }
    std::size_t continuation_count = 0;
    if (byte >= 0xc2 && byte <= 0xdf) {
      continuation_count = 1;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      continuation_count = 2;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      continuation_count = 3;
    } else {
      return std::numeric_limits<std::size_t>::max();
    }
    if (offset + continuation_count > value.size()) {
      return std::numeric_limits<std::size_t>::max();
    }
    std::uint32_t code_point = byte & ((1U << (6 - continuation_count)) - 1U);
    for (std::size_t index = 0; index < continuation_count; ++index) {
      const auto continuation = static_cast<unsigned char>(value[offset++]);
      if ((continuation & 0xc0) != 0x80) {
        return std::numeric_limits<std::size_t>::max();
      }
      code_point = (code_point << 6) | (continuation & 0x3f);
    }
    if ((continuation_count == 2 && code_point < 0x800)
        || (continuation_count == 3 && code_point < 0x10000)
        || code_point > 0x10ffff
        || (code_point >= 0xd800 && code_point <= 0xdfff)) {
      return std::numeric_limits<std::size_t>::max();
    }
    length += code_point > 0xffff ? 2 : 1;
  }
  return length;
}

bool IncrementalOutputAssembler::start_turn(std::string_view turn_id) {
  const std::string id(turn_id);
  if (id.empty() || completed_turn_ids_.contains(id)
      || turns_.contains(id) || turns_.size() >= kMaxTrackedTurns) {
    return false;
  }
  turns_.try_emplace(id);
  return true;
}

bool IncrementalOutputAssembler::has_output(std::string_view turn_id) const {
  const auto turn_it = turns_.find(std::string(turn_id));
  return turn_it != turns_.end() && !turn_it->second.segments.empty();
}

IncrementalOutputAssembler::IngestResult
IncrementalOutputAssembler::validate_event_identity(
    const IncrementalIdentity& identity,
    TurnState*& turn) {
  if (completed_turn_ids_.contains(identity.turn_id)) {
    return {false, "incremental_output_turn_finished"};
  }
  const auto turn_it = turns_.find(identity.turn_id);
  if (turn_it == turns_.end()) {
    return {false, "incremental_output_turn_not_started"};
  }
  turn = &turn_it->second;
  if (turn->interrupted) {
    return {false, "incremental_output_turn_interrupted"};
  }
  if (turn->synthesis_finished) {
    return {false, "incremental_output_after_synth_finished"};
  }
  return {true, {}};
}

IncrementalOutputAssembler::IngestResult
IncrementalOutputAssembler::validate_stream(
    TurnState& turn,
    const IncrementalIdentity& identity,
    IncrementalOutputResource resource,
    StreamState*& stream,
    SegmentState*& segment) {
  const auto segment_it = turn.segments.find(identity.segment_message_id);
  if (segment_it == turn.segments.end()) {
    return {false, "incremental_output_segment_identity_mismatch"};
  }
  segment = &segment_it->second;
  if (segment->core_turn_id != identity.core_turn_id
      || segment->persona_result_id != identity.persona_result_id
      || segment->segment_index != identity.segment_index) {
    return {false, "incremental_output_segment_identity_mismatch"};
  }
  auto& stream_slot = segment->streams[resource_index(resource)];
  if (!stream_slot || stream_slot->id != identity.stream_id
      || stream_slot->status != StreamStatus::Open
      || stream_slot->next_seq != identity.seq) {
    return {false, "incremental_output_stream_order_invalid"};
  }
  stream = &*stream_slot;
  return {true, {}};
}

IncrementalOutputAssembler::IngestResult
IncrementalOutputAssembler::start_stream(
    TurnState& turn,
    const IncrementalIdentity& identity,
    IncrementalOutputResource resource) {
  for (const auto& [_, prior] : turn.segments) {
    for (const auto& prior_stream : prior.streams) {
      if (prior_stream && prior_stream->id == identity.stream_id) {
        return {false, "incremental_output_duplicate_stream_id"};
      }
    }
  }
  auto segment_it = turn.segments.find(identity.segment_message_id);
  if (segment_it == turn.segments.end()) {
    if (turn.segment_order.size() >= kMaxSegmentsPerTurn) {
      return {false, "incremental_output_segment_order_or_capacity_invalid"};
    }
    for (const auto& [_, prior] : turn.segments) {
      if (prior.core_turn_id != identity.core_turn_id) {
        return {false, "incremental_output_mixed_delivery_or_result"};
      }
    }
    std::size_t result_segment_count = 0;
    for (const auto& [_, prior] : turn.segments) {
      if (prior.persona_result_id == identity.persona_result_id) {
        ++result_segment_count;
      }
    }
    if (identity.segment_index != result_segment_count) {
      return {false, "incremental_output_result_segment_order_invalid"};
    }
    if (!turn.segment_order.empty()) {
      const auto& previous_id = turn.segment_order.back();
      const auto previous_it = turn.segments.find(previous_id);
      if (previous_it != turn.segments.end()
          && previous_it->second.persona_result_id != identity.persona_result_id) {
        const auto has_unclosed_stream = std::ranges::any_of(
            previous_it->second.streams,
            [](const auto& stream) {
              return !stream || !is_terminal(stream->status);
            });
        if (result_segment_count || has_unclosed_stream) {
          return {false, "incremental_output_previous_result_unclosed"};
        }
      }
    }
    SegmentState segment{
        identity.core_turn_id,
        identity.persona_result_id,
        identity.segment_index};
    turn.segment_order.push_back(identity.segment_message_id);
    segment_it = turn.segments.emplace(
        identity.segment_message_id, std::move(segment)).first;
  } else {
    auto& segment = segment_it->second;
    if (segment.core_turn_id != identity.core_turn_id
        || segment.persona_result_id != identity.persona_result_id
        || segment.segment_index != identity.segment_index) {
      return {false, "incremental_output_segment_identity_mismatch"};
    }
  }

  auto& segment = segment_it->second;
  auto& stream_slot = segment.streams[resource_index(resource)];
  if (stream_slot.has_value()) {
    return {false, "incremental_output_duplicate_start"};
  }
  stream_slot = StreamState{identity.stream_id};
  return {true, {}};
}

IncrementalOutputAssembler::IngestResult
IncrementalOutputAssembler::ingest(IncrementalOutputEvent event) {
  TurnState* turn = nullptr;
  auto result = validate_event_identity(event.identity, turn);
  if (!result.accepted) {
    return result;
  }
  if (event.kind == IncrementalOutputEventKind::Start) {
    if (event.identity.seq != 0) {
      return {false, "incremental_output_start_sequence_invalid"};
    }
    return start_stream(*turn, event.identity, event.resource);
  }

  StreamState* stream = nullptr;
  SegmentState* segment = nullptr;
  result = validate_stream(
      *turn, event.identity, event.resource, stream, segment);
  if (!result.accepted) {
    return result;
  }
  if (event.kind == IncrementalOutputEventKind::TextDelta) {
    const auto delta_units = utf16_length(event.text);
    if (delta_units == std::numeric_limits<std::size_t>::max()
        || segment->text_units > kMaxSegmentTextUnits - delta_units) {
      return {false, "incremental_output_text_capacity_or_delta_invalid"};
    }
    std::size_t turn_units = 0;
    for (const auto& [_, prior] : turn->segments) {
      turn_units += prior.text_units;
    }
    if (turn_units > kMaxTurnTextUnits - delta_units) {
      return {false, "incremental_output_text_capacity_or_delta_invalid"};
    }
    segment->text_units += delta_units;
    ++stream->next_seq;
    return {true, {}};
  }
  if (event.kind == IncrementalOutputEventKind::MotionUpdate) {
    ++stream->next_seq;
    return {true, {}};
  }

  if (event.status != IncrementalOutputStatus::Completed
      && event.reason.empty()) {
    return {false, "incremental_output_end_status_invalid"};
  }
  if (event.resource == IncrementalOutputResource::Text) {
    if (!event.length.has_value() || *event.length != segment->text_units) {
      return {false, "incremental_output_end_length_mismatch"};
    }
  } else if (event.resource == IncrementalOutputResource::Audio) {
    if (!event.length.has_value() || *event.length != stream->samples) {
      return {false, "incremental_output_end_length_mismatch"};
    }
  }
  stream->status = status_for(event.status);
  ++stream->next_seq;
  return {true, {}};
}

IncrementalOutputAssembler::IngestResult
IncrementalOutputAssembler::ingest_audio(OutputAudioFrame frame) {
  TurnState* turn = nullptr;
  auto result = validate_event_identity(frame.identity, turn);
  if (!result.accepted) {
    return result;
  }
  StreamState* stream = nullptr;
  SegmentState* segment = nullptr;
  result = validate_stream(
      *turn,
      frame.identity,
      IncrementalOutputResource::Audio,
      stream,
      segment);
  if (!result.accepted) {
    return result;
  }
  (void)segment;
  const auto segment_index = std::find(
      turn->segment_order.begin(),
      turn->segment_order.end(),
      frame.identity.segment_message_id);
  if (segment_index == turn->segment_order.end()) {
    return {false, "incremental_output_segment_identity_mismatch"};
  }
  for (auto it = turn->segment_order.begin(); it != segment_index; ++it) {
    const auto prior = turn->segments.find(*it);
    if (prior == turn->segments.end()) {
      return {false, "incremental_output_audio_segment_order_invalid"};
    }
    const auto& prior_audio = prior->second.streams[resource_index(
        IncrementalOutputResource::Audio)];
    if (!prior_audio || !is_terminal(prior_audio->status)) {
      return {false, "incremental_output_audio_segment_order_invalid"};
    }
  }
  if (frame.pcm.empty() || frame.pcm.size() > 64 * 1024
      || frame.pcm.size() % 2 != 0
      || frame.sample_offset != stream->samples
      || stream->samples > kMaxJavaScriptSafeInteger - frame.pcm.size() / 2) {
    return {false, "incremental_output_audio_offset_invalid"};
  }
  stream->samples += frame.pcm.size() / 2;
  ++stream->next_seq;
  return {true, {}};
}

bool IncrementalOutputAssembler::mark_synthesis_finished(
    std::string_view turn_id) {
  const auto turn_it = turns_.find(std::string(turn_id));
  if (turn_it == turns_.end()) {
    return false;
  }
  auto& turn = turn_it->second;
  if (turn.interrupted || turn.synthesis_finished) {
    return false;
  }
  if (turn.segments.empty()) {
    return false;
  }
  for (const auto& [_, segment] : turn.segments) {
    for (const auto& stream : segment.streams) {
      if (!stream || !is_terminal(stream->status)) {
        return false;
      }
    }
  }
  turn.synthesis_finished = true;
  return true;
}

bool IncrementalOutputAssembler::interrupt_turn(std::string_view turn_id) {
  const auto turn_it = turns_.find(std::string(turn_id));
  if (turn_it == turns_.end() || turn_it->second.interrupted) {
    return false;
  }
  turn_it->second.interrupted = true;
  turn_it->second.segments.clear();
  turn_it->second.segment_order.clear();
  return true;
}

bool IncrementalOutputAssembler::clear_turn(std::string_view turn_id) {
  std::string id(turn_id);
  if (id.empty() || turns_.erase(id) == 0
      || !completed_turn_ids_.emplace(id).second) {
    return false;
  }
  completed_turn_id_order_.push_back(std::move(id));
  if (completed_turn_id_order_.size() > kMaxRememberedCompletedTurnIds) {
    completed_turn_ids_.erase(completed_turn_id_order_.front());
    completed_turn_id_order_.pop_front();
  }
  return true;
}

void IncrementalOutputAssembler::clear_all() {
  turns_.clear();
  completed_turn_ids_.clear();
  completed_turn_id_order_.clear();
}

}  // namespace ag99::runtime
