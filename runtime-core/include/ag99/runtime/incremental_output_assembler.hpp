#pragma once

#include <cstdint>
#include <deque>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "ag99/runtime/protocol.hpp"

namespace ag99::runtime {

class IncrementalOutputAssembler final {
 public:
  struct IngestResult {
    bool accepted = false;
    std::string reason;
  };

  bool start_turn(std::string_view turn_id);
  bool has_output(std::string_view turn_id) const;
  IngestResult ingest(IncrementalOutputEvent event);
  IngestResult ingest_audio(OutputAudioFrame frame);
  bool mark_synthesis_finished(std::string_view turn_id);
  bool interrupt_turn(std::string_view turn_id);
  bool clear_turn(std::string_view turn_id);
  void clear_all();

 private:
  enum class StreamStatus { Open, Completed, Failed, Cancelled };

  struct StreamState {
    std::string id;
    std::uint64_t next_seq = 1;
    std::uint64_t samples = 0;
    StreamStatus status = StreamStatus::Open;
  };

  struct SegmentState {
    std::string core_turn_id;
    std::string persona_result_id;
    std::uint64_t segment_index = 0;
    std::size_t text_units = 0;
    std::size_t text_codepoints = 0;
    std::vector<std::optional<StreamState>> streams =
        std::vector<std::optional<StreamState>>(3);
  };

  struct TurnState {
    bool synthesis_finished = false;
    bool interrupted = false;
    std::vector<std::string> segment_order;
    std::unordered_map<std::string, SegmentState> segments;
  };

  static std::size_t resource_index(IncrementalOutputResource resource);
  static bool is_terminal(StreamStatus status);
  static StreamStatus status_for(IncrementalOutputStatus status);
  static std::size_t utf16_length(std::string_view value);
  static std::size_t utf8_codepoint_length(std::string_view value);

  IngestResult validate_event_identity(
      const IncrementalIdentity& identity,
      TurnState*& turn);
  IngestResult validate_stream(
      TurnState& turn,
      const IncrementalIdentity& identity,
      IncrementalOutputResource resource,
      StreamState*& stream,
      SegmentState*& segment);
  IngestResult start_stream(
      TurnState& turn,
      const IncrementalIdentity& identity,
      IncrementalOutputResource resource);

  std::unordered_map<std::string, TurnState> turns_;
  std::unordered_set<std::string> completed_turn_ids_;
  std::deque<std::string> completed_turn_id_order_;
};

}  // namespace ag99::runtime
