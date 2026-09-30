#include "ag99/runtime/protocol.hpp"
#include "ag99/runtime/runtime_session.hpp"
#include "ag99/runtime/segment_assembler.hpp"

#include <cassert>
#include <cstdint>
#include <string>
#include <vector>

namespace {

ag99::runtime::Json make_segment(
    std::string message_id,
    std::int64_t sequence,
    std::string source = "adapter") {
  return {
      {"type", "output.segment"},
      {"version", "v2"},
      {"message_id", std::move(message_id)},
      {"timestamp", "2026-10-01T00:00:00.000Z"},
      {"turn_id", "turn-1"},
      {"source", std::move(source)},
      {"payload",
       {
           {"schema_version", "output.segment.v5"},
           {"sequence", sequence},
           {"text", {{"state", "present"}, {"content", "hello"}}},
           {"audio", {{"state", "absent"}}},
           {"motion", {{"state", "absent"}}},
           {"speech", {{"state", "absent"}}},
           {"images", nlohmann::json::array()},
           {"speaker_name", ""},
           {"avatar", ""},
       }},
  };
}

void test_envelope_and_segment() {
  const auto envelope = ag99::runtime::parse_envelope(make_segment("m-1", 0));
  const auto segment = ag99::runtime::parse_output_segment(envelope);
  assert(segment.sequence == 0);
  assert(segment.text.state == ag99::runtime::TextSlot::State::Present);
  assert(segment.text.content == "hello");
}

void test_segment_rejection_boundaries() {
  {
    const auto envelope = ag99::runtime::parse_envelope(
        make_segment("m-source", 0, "frontend"));
    bool rejected = false;
    try {
      (void)ag99::runtime::parse_output_segment(envelope);
    } catch (const ag99::runtime::ProtocolError&) {
      rejected = true;
    }
    assert(rejected);
  }

  {
    auto raw = make_segment("m-missing", 0);
    raw["payload"].erase("audio");
    bool rejected = false;
    try {
      (void)ag99::runtime::parse_output_segment(
          ag99::runtime::parse_envelope(raw));
    } catch (const ag99::runtime::ProtocolError&) {
      rejected = true;
    }
    assert(rejected);
  }

  {
    auto raw = make_segment("m-audio-without-text", 0);
    raw["payload"]["text"] = {{"state", "absent"}};
    raw["payload"]["audio"] = {
        {"state", "present"},
        {"url", "http://127.0.0.1:12396/audio.wav"},
    };
    bool rejected = false;
    try {
      (void)ag99::runtime::parse_output_segment(
          ag99::runtime::parse_envelope(raw));
    } catch (const ag99::runtime::ProtocolError&) {
      rejected = true;
    }
    assert(rejected);
  }
}

void test_binary_audio_round_trip() {
  const ag99::runtime::AudioChunkMetadata metadata{
      "mic:1", "turn-1", 7, "pcm16le", 16000, 1, "ptt"};
  const std::vector<std::uint8_t> payload = {0x01, 0x00, 0xff, 0xff};
  auto frame = ag99::runtime::build_binary_audio_frame(metadata, payload);
  const auto parsed = ag99::runtime::parse_binary_audio_frame(frame);
  assert(parsed.metadata.stream_id == "mic:1");
  assert(parsed.metadata.sequence == 7);
  assert(parsed.metadata.sample_rate == 16000);
  assert(parsed.payload == payload);

  frame[6] = 1;
  bool rejected = false;
  try {
    (void)ag99::runtime::parse_binary_audio_frame(frame);
  } catch (const ag99::runtime::ProtocolError&) {
    rejected = true;
  }
  assert(rejected);
}

void test_segment_reorder_and_duplicate_rejection() {
  ag99::runtime::SegmentAssembler assembler;
  auto second = ag99::runtime::parse_output_segment(
      ag99::runtime::parse_envelope(make_segment("m-2", 1)));
  auto first = ag99::runtime::parse_output_segment(
      ag99::runtime::parse_envelope(make_segment("m-1", 0)));
  const auto delayed = assembler.ingest(std::move(second));
  assert(delayed.accepted);
  assert(delayed.ready.empty());
  const auto ready = assembler.ingest(std::move(first));
  assert(ready.accepted);
  assert(ready.ready.size() == 2);
  const auto duplicate = assembler.ingest(
      ag99::runtime::parse_output_segment(
          ag99::runtime::parse_envelope(make_segment("m-1", 0))));
  assert(!duplicate.accepted);
  assert(duplicate.reason == "segment_duplicate_committed");

  const auto late = assembler.ingest(
      ag99::runtime::parse_output_segment(
          ag99::runtime::parse_envelope(make_segment("m-late", 0))));
  assert(!late.accepted);
  assert(late.reason == "segment_sequence_late");
}

void test_input_text_builder() {
  const auto envelope = ag99::runtime::build_input_text(
      "hello",
      {},
      "turn-1",
      "message-1",
      "2026-10-01T00:00:00.000Z");
  assert(envelope.at("type") == "input.text");
  assert(envelope.at("version") == "v2");
  assert(envelope.at("source") == "frontend");
  assert(envelope.at("turn_id") == "turn-1");
}

void test_runtime_session_dispatch() {
  std::vector<std::string> ready_messages;
  std::vector<std::string> errors;
  ag99::runtime::RuntimeProtocolSession session({
      [&](ag99::runtime::OutputSegment segment) {
        ready_messages.push_back(segment.envelope.message_id);
      },
      {},
      {},
      [&](std::string message) { errors.push_back(std::move(message)); },
  });

  session.ingest_text(make_segment("m-2", 1).dump());
  session.ingest_text(make_segment("m-1", 0).dump());
  assert((ready_messages == std::vector<std::string>{"m-1", "m-2"}));
  assert(errors.empty());

  session.ingest_text("{\"type\":\"output.segment\",\"version\":\"v1\"}");
  assert(errors.size() == 1);
}

void test_audio_control_builders() {
  const auto start = ag99::runtime::build_input_audio_stream_start(
      "stream-1",
      "microphone",
      16000,
      1,
      "ptt",
      "device-1",
      "turn-1",
      "start-1",
      "2026-10-01T00:00:00.000Z");
  assert(start.at("type") == "input.audio_stream_start");
  assert(start.at("payload").at("encoding") == "pcm16le");
  assert(start.at("payload").at("capture_mode") == "ptt");

  const auto end = ag99::runtime::build_input_audio_stream_end(
      "stream-1",
      "ptt_release",
      false,
      7,
      "ptt",
      {"data:image/png;base64,abc"},
      true,
      "turn-1");
  assert(end.at("type") == "input.audio_stream_end");
  assert(end.at("payload").at("last_seq") == 7);
  assert(end.at("payload").at("desktop_snapshot_requested") == true);

  const auto finished = ag99::runtime::build_control_playback_finished(
      "turn-1",
      false,
      "audio_playback_interrupted");
  assert(finished.at("type") == "control.playback_finished");
  assert(finished.at("payload").at("success") == false);
}

}  // namespace

int main() {
  test_envelope_and_segment();
  test_segment_rejection_boundaries();
  test_binary_audio_round_trip();
  test_segment_reorder_and_duplicate_rejection();
  test_input_text_builder();
  test_runtime_session_dispatch();
  test_audio_control_builders();
  return 0;
}
