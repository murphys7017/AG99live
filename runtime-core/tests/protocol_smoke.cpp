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
    std::string source = "adapter",
    std::string turn_id = "turn-1") {
  return {
      {"type", "output.segment"},
      {"version", "v2"},
      {"message_id", std::move(message_id)},
      {"timestamp", "2026-10-01T00:00:00.000Z"},
      {"turn_id", std::move(turn_id)},
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

ag99::runtime::Json make_model_sync() {
  const ag99::runtime::Json models = nlohmann::json::array({
      {
          {"name", "Demo"},
          {"semantic_axis_profile", nullptr},
      },
  });
  return {
      {"type", "system.model_sync"},
      {"version", "v2"},
      {"message_id", "sync-1"},
      {"timestamp", "2026-10-01T00:00:00.000Z"},
      {"turn_id", nullptr},
      {"source", "adapter"},
      {"payload",
       {
           {"model_info",
            {
                {"schema_version", "live2d_scan.v4"},
                {"selected_model", "Demo"},
                {"models", models},
            }},
           {"runtime_cache_errors", nlohmann::json::object()},
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

void test_parameter_plan_motion_slot() {
  auto raw = make_segment("m-plan", 0);
  raw["payload"]["motion"] = {
      {"state", "present"},
      {"message_type", "engine.parameter_plan"},
      {"mode", "expressive"},
      {"source", "frontend"},
      {"payload",
       {
           {"schema_version", "engine.parameter_plan.v3"},
       }},
  };
  const auto segment = ag99::runtime::parse_output_segment(
      ag99::runtime::parse_envelope(raw));
  assert(segment.motion.state == ag99::runtime::MotionSlot::State::Present);
  assert(segment.motion.message_type == "engine.parameter_plan");
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
  assert(assembler.start_turn("turn-1"));
  assert(!assembler.start_turn("turn-1"));
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

  assert(assembler.clear_turn("turn-1"));
  const auto after_finish = assembler.ingest(
      ag99::runtime::parse_output_segment(
          ag99::runtime::parse_envelope(make_segment("m-after-finish", 2))));
  assert(!after_finish.accepted);
  assert(after_finish.reason == "segment_turn_finished");
  assert(!assembler.start_turn("turn-1"));
  assert(!assembler.clear_turn("unknown-turn"));
  assert(assembler.start_turn("unknown-turn"));

  ag99::runtime::SegmentAssembler full_pending;
  assert(full_pending.start_turn("turn-full"));
  for (std::int64_t sequence = 1; sequence <= 256; ++sequence) {
    const auto pending = full_pending.ingest(
        ag99::runtime::parse_output_segment(
            ag99::runtime::parse_envelope(make_segment(
                "m-full-" + std::to_string(sequence),
                sequence,
                "adapter",
                "turn-full"))));
    assert(pending.accepted);
    assert(pending.ready.empty());
  }
  const auto drained = full_pending.ingest(
      ag99::runtime::parse_output_segment(
          ag99::runtime::parse_envelope(make_segment(
              "m-full-0", 0, "adapter", "turn-full"))));
  assert(drained.accepted);
  assert(drained.ready.size() == 257);
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
  std::vector<std::string> synced_models;
  std::vector<std::string> started_turns;
  std::vector<std::string> finished_turns;
  std::vector<std::string> errors;
  ag99::runtime::RuntimeProtocolSession session({
      [&](ag99::runtime::OutputSegment segment) {
        ready_messages.push_back(segment.envelope.message_id);
      },
      {},
      {},
      [&](std::string message) { errors.push_back(std::move(message)); },
      [&](ag99::runtime::ModelSync sync) {
        synced_models.push_back(
            sync.payload.at("model_info").at("selected_model").get<std::string>());
      },
      [&](std::string turn_id) { started_turns.push_back(std::move(turn_id)); },
      [&](std::string turn_id) { finished_turns.push_back(std::move(turn_id)); },
  });

  session.ingest_text(make_model_sync().dump());
  assert((synced_models == std::vector<std::string>{"Demo"}));
  session.ingest_text(ag99::runtime::Json{
      {"type", "control.turn_started"},
      {"version", "v2"},
      {"message_id", "turn-start-1"},
      {"timestamp", "2026-10-01T00:00:00.000Z"},
      {"turn_id", "turn-1"},
      {"source", "adapter"},
      {"payload", ag99::runtime::Json::object()},
  }.dump());
  assert((started_turns == std::vector<std::string>{"turn-1"}));
  session.ingest_text(ag99::runtime::Json{
      {"type", "control.turn_started"},
      {"version", "v2"},
      {"message_id", "turn-start-duplicate"},
      {"timestamp", "2026-10-01T00:00:00.000Z"},
      {"turn_id", "turn-1"},
      {"source", "adapter"},
      {"payload", ag99::runtime::Json::object()},
  }.dump());
  assert((started_turns == std::vector<std::string>{"turn-1"}));
  assert(errors.size() == 1);
  session.ingest_text(make_segment("m-2", 1).dump());
  session.ingest_text(make_segment("m-1", 0).dump());
  assert((ready_messages == std::vector<std::string>{"m-1", "m-2"}));
  session.ingest_text(ag99::runtime::Json{
      {"type", "control.turn_finished"},
      {"version", "v2"},
      {"message_id", "turn-finish-1"},
      {"timestamp", "2026-10-01T00:00:00.000Z"},
      {"turn_id", "turn-1"},
      {"source", "adapter"},
      {"payload", {{"success", true}}},
  }.dump());
  assert((finished_turns == std::vector<std::string>{"turn-1"}));
  session.ingest_text(make_segment("m-late", 2).dump());
  assert(ready_messages.size() == 2);
  assert(errors.size() == 2);
  session.ingest_text(ag99::runtime::Json{
      {"type", "control.interrupt"},
      {"version", "v2"},
      {"message_id", "turn-interrupt-2"},
      {"timestamp", "2026-10-01T00:00:01.000Z"},
      {"turn_id", "turn-2"},
      {"source", "adapter"},
      {"payload", ag99::runtime::Json::object()},
  }.dump());
  assert((finished_turns == std::vector<std::string>{"turn-1"}));
  assert(errors.size() == 3);

  session.ingest_text(ag99::runtime::Json{
      {"type", "control.turn_started"},
      {"version", "v2"},
      {"message_id", "turn-start-2"},
      {"timestamp", "2026-10-01T00:00:01.000Z"},
      {"turn_id", "turn-2"},
      {"source", "adapter"},
      {"payload", ag99::runtime::Json::object()},
  }.dump());
  session.ingest_text(make_segment("m-turn-2", 0, "adapter", "turn-2").dump());
  assert(ready_messages.size() == 3);

  session.ingest_text(ag99::runtime::Json{
      {"type", "control.interrupt"},
      {"version", "v2"},
      {"message_id", "turn-interrupt-active"},
      {"timestamp", "2026-10-01T00:00:02.000Z"},
      {"turn_id", "turn-2"},
      {"source", "adapter"},
      {"payload", ag99::runtime::Json::object()},
  }.dump());
  assert((finished_turns == std::vector<std::string>{"turn-1", "turn-2"}));
  session.ingest_text(make_segment("m-interrupted", 1, "adapter", "turn-2").dump());
  assert(ready_messages.size() == 3);
  assert(errors.size() == 4);

  session.ingest_text(ag99::runtime::Json{
      {"type", "control.turn_started"},
      {"version", "v2"},
      {"message_id", "turn-start-missing"},
      {"timestamp", "2026-10-01T00:00:00.000Z"},
      {"turn_id", nullptr},
      {"source", "adapter"},
      {"payload", ag99::runtime::Json::object()},
  }.dump());
  assert(errors.size() == 5);

  session.ingest_text("{\"type\":\"output.segment\",\"version\":\"v1\"}");
  assert(errors.size() == 6);
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
  test_parameter_plan_motion_slot();
  test_binary_audio_round_trip();
  test_segment_reorder_and_duplicate_rejection();
  test_input_text_builder();
  test_runtime_session_dispatch();
  test_audio_control_builders();
  return 0;
}
