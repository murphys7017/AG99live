#pragma once

#include <cstdint>
#include <functional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "ag99/runtime/protocol.hpp"
#include "ag99/runtime/segment_assembler.hpp"

namespace ag99::runtime {

struct RuntimeSessionCallbacks {
  std::function<void(OutputSegment)> on_segment_ready;
  std::function<void(BinaryAudioChunkFrame)> on_audio_chunk;
  std::function<void(std::string)> on_ignored_type;
  std::function<void(std::string)> on_protocol_error;
  std::function<void(ModelSync)> on_model_sync;
  std::function<void(std::string)> on_turn_started;
  std::function<void(std::string)> on_synth_finished;
  std::function<void(std::string, bool, std::string)> on_turn_finished;
  std::function<void(std::string)> on_turn_interrupted;
  std::function<void(DesktopSettingsQuery)> on_desktop_settings_query;
};

class RuntimeProtocolSession final {
 public:
  explicit RuntimeProtocolSession(RuntimeSessionCallbacks callbacks = {});

  RuntimeProtocolSession(const RuntimeProtocolSession&) = delete;
  RuntimeProtocolSession& operator=(const RuntimeProtocolSession&) = delete;

  void ingest_text(std::string_view text_frame);
  void ingest_binary(std::span<const std::uint8_t> binary_frame);
  void reset();

 private:
  void report_error(std::string message);

  RuntimeSessionCallbacks callbacks_;
  SegmentAssembler assembler_;
};

}  // namespace ag99::runtime
