#include "ag99/runtime/runtime_session.hpp"

#include <exception>
#include <utility>

namespace ag99::runtime {

RuntimeProtocolSession::RuntimeProtocolSession(
    RuntimeSessionCallbacks callbacks)
    : callbacks_(std::move(callbacks)) {}

void RuntimeProtocolSession::ingest_text(std::string_view text_frame) {
  try {
    const auto envelope = parse_envelope_json(text_frame);
    if (envelope.type != "output.segment") {
      if (callbacks_.on_ignored_type) {
        callbacks_.on_ignored_type(envelope.type);
      }
      return;
    }

    auto segment = parse_output_segment(envelope);
    auto result = assembler_.ingest(std::move(segment));
    if (!result.accepted) {
      report_error("segment rejected: " + result.reason);
      return;
    }
    for (auto& ready : result.ready) {
      if (callbacks_.on_segment_ready) {
        callbacks_.on_segment_ready(std::move(ready));
      }
    }
  } catch (const std::exception& error) {
    report_error(error.what());
  }
}

void RuntimeProtocolSession::ingest_binary(
    std::span<const std::uint8_t> binary_frame) {
  try {
    auto audio = parse_binary_audio_frame(binary_frame);
    if (callbacks_.on_audio_chunk) {
      callbacks_.on_audio_chunk(std::move(audio));
    }
  } catch (const std::exception& error) {
    report_error(error.what());
  }
}

void RuntimeProtocolSession::reset() {
  assembler_.clear_all();
}

void RuntimeProtocolSession::report_error(std::string message) {
  if (callbacks_.on_protocol_error) {
    callbacks_.on_protocol_error(std::move(message));
  }
}

}  // namespace ag99::runtime
