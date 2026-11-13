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
    if (envelope.type == "control.turn_started") {
      if (envelope.source != "adapter") {
        throw ProtocolError("control.turn_started.source must be adapter");
      }
      if (!envelope.turn_id.has_value()) {
        throw ProtocolError("control.turn_started requires turn_id");
      }
      if (!envelope.payload.empty()) {
        throw ProtocolError("control.turn_started payload must be empty");
      }
      if (!assembler_.start_turn(*envelope.turn_id)) {
        throw ProtocolError("control.turn_started duplicate or retired turn");
      }
      if (!incremental_assembler_.start_turn(*envelope.turn_id)) {
        throw ProtocolError(
            "control.turn_started duplicate or retired incremental turn");
      }
      if (callbacks_.on_turn_started) {
        callbacks_.on_turn_started(*envelope.turn_id);
      }
      return;
    }
    if (envelope.type == "control.synth_finished") {
      if (envelope.source != "adapter") {
        throw ProtocolError("control.synth_finished.source must be adapter");
      }
      if (!envelope.turn_id.has_value()) {
        throw ProtocolError("control.synth_finished requires turn_id");
      }
      if (!envelope.payload.empty()) {
        throw ProtocolError("control.synth_finished payload must be empty");
      }
      const auto has_incremental_output =
          incremental_assembler_.has_output(*envelope.turn_id);
      if (has_incremental_output
          && !incremental_assembler_.mark_synthesis_finished(
              *envelope.turn_id)) {
        throw ProtocolError(
            "control.synth_finished has pending incremental output");
      }
      if (!assembler_.mark_synthesis_finished(
              *envelope.turn_id, has_incremental_output)) {
        throw ProtocolError(
            "control.synth_finished unknown, duplicate, or has pending output");
      }
      if (callbacks_.on_synth_finished) {
        callbacks_.on_synth_finished(*envelope.turn_id);
      }
      return;
    }
    if (envelope.type == "control.turn_finished") {
      if (envelope.source != "adapter") {
        throw ProtocolError("control.turn_finished.source must be adapter");
      }
      if (!envelope.turn_id.has_value()) {
        throw ProtocolError("control.turn_finished requires turn_id");
      }
      if (!envelope.payload.is_object()) {
        throw ProtocolError("control.turn_finished payload must be an object");
      }
      const auto success = envelope.payload.find("success");
      if (success == envelope.payload.end() || !success->is_boolean()) {
        throw ProtocolError("control.turn_finished payload.success must be boolean");
      }
      const auto reason = envelope.payload.find("reason");
      if (reason != envelope.payload.end() && !reason->is_string()) {
        throw ProtocolError("control.turn_finished payload.reason must be string");
      }
      for (const auto& [key, _] : envelope.payload.items()) {
        if (key != "success" && key != "reason") {
          throw ProtocolError(
              "control.turn_finished payload." + key + " is not allowed");
        }
      }
      if (!assembler_.clear_turn(*envelope.turn_id)) {
        throw ProtocolError("control.turn_finished unknown or retired turn");
      }
      if (!incremental_assembler_.clear_turn(*envelope.turn_id)) {
        throw ProtocolError(
            "control.turn_finished unknown or retired incremental turn");
      }
      if (callbacks_.on_turn_finished) {
        callbacks_.on_turn_finished(
            *envelope.turn_id,
            success->get<bool>(),
            reason == envelope.payload.end() ? std::string{}
                                             : reason->get<std::string>());
      }
      return;
    }
    if (envelope.type == "control.interrupt") {
      if (envelope.source != "adapter") {
        throw ProtocolError("control.interrupt.source must be adapter");
      }
      if (!envelope.turn_id.has_value()) {
        throw ProtocolError("control.interrupt requires turn_id");
      }
      if (!envelope.payload.empty()) {
        throw ProtocolError("control.interrupt payload must be empty");
      }
      if (!assembler_.interrupt_turn(*envelope.turn_id)) {
        throw ProtocolError("control.interrupt unknown, duplicate, or retired turn");
      }
      if (!incremental_assembler_.interrupt_turn(*envelope.turn_id)) {
        throw ProtocolError(
            "control.interrupt unknown, duplicate, or retired incremental turn");
      }
      if (callbacks_.on_turn_interrupted) {
        callbacks_.on_turn_interrupted(*envelope.turn_id);
      }
      return;
    }
    if (envelope.type == "system.model_sync") {
      auto sync = parse_model_sync(envelope);
      if (callbacks_.on_model_sync) {
        callbacks_.on_model_sync(std::move(sync));
      }
      return;
    }
    if (envelope.type == "output.pre_action") {
      auto event = parse_pre_action(envelope);
      if (callbacks_.on_pre_action) {
        callbacks_.on_pre_action(std::move(event));
      }
      return;
    }
    if (envelope.type == "system.desktop_settings_query") {
      auto query = parse_desktop_settings_query(envelope);
      if (callbacks_.on_desktop_settings_query) {
        callbacks_.on_desktop_settings_query(std::move(query));
      }
      return;
    }
    if (envelope.type == "output.segment_motion") {
      auto update = parse_segment_motion_update(envelope);
      if (callbacks_.on_segment_motion_ready) {
        callbacks_.on_segment_motion_ready(std::move(update));
      }
      return;
    }
    if (auto event = parse_incremental_output_event(envelope);
        event.has_value()) {
      const auto result = incremental_assembler_.ingest(*event);
      if (!result.accepted) {
        report_error("incremental output rejected: " + result.reason);
        return;
      }
      if (callbacks_.on_incremental_output_event) {
        callbacks_.on_incremental_output_event(std::move(*event));
      }
      return;
    }
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
    const bool is_incremental_audio = binary_frame.size() >= 6
        && binary_frame[0] == static_cast<std::uint8_t>('A')
        && binary_frame[1] == static_cast<std::uint8_t>('G')
        && binary_frame[2] == static_cast<std::uint8_t>('9')
        && binary_frame[3] == static_cast<std::uint8_t>('9')
        && binary_frame[5] == 2;
    if (is_incremental_audio) {
      auto audio = parse_output_audio_frame(binary_frame);
      const auto result = incremental_assembler_.ingest_audio(audio);
      if (!result.accepted) {
        report_error("incremental audio rejected: " + result.reason);
        return;
      }
      if (callbacks_.on_incremental_audio_frame) {
        callbacks_.on_incremental_audio_frame(std::move(audio));
      }
      return;
    }
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
  incremental_assembler_.clear_all();
}

void RuntimeProtocolSession::report_error(std::string message) {
  if (callbacks_.on_protocol_error) {
    callbacks_.on_protocol_error(std::move(message));
  }
}

}  // namespace ag99::runtime
