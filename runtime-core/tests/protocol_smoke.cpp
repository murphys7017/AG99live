#include "ag99/runtime/protocol.hpp"
#include "ag99/runtime/runtime_session.hpp"
#include "ag99/runtime/segment_assembler.hpp"

#ifdef NDEBUG
#undef NDEBUG
#endif
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
           {"schema_version", "output.segment.v6"},
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

void test_pending_and_deferred_motion_slots() {
  auto pending = make_segment("m-pending", 0);
  pending["payload"]["audio"] = {
      {"state", "present"},
      {"url", "http://127.0.0.1:12396/audio.wav"},
  };
  pending["payload"]["motion"] = {{"state", "pending"}};
  const auto pending_segment = ag99::runtime::parse_output_segment(
      ag99::runtime::parse_envelope(pending));
  assert(pending_segment.motion.state
      == ag99::runtime::MotionSlot::State::Pending);

  const ag99::runtime::Json update = {
      {"type", "output.segment_motion"},
      {"version", "v2"},
      {"message_id", "m-pending"},
      {"timestamp", "2026-10-01T00:00:00.000Z"},
      {"turn_id", "turn-1"},
      {"source", "adapter"},
      {"payload",
       {
           {"schema_version", "output.segment.v6"},
           {"motion",
            {
                {"state", "present"},
                {"message_type", "engine.motion_intent"},
                {"mode", "expressive"},
                {"source", "adapter"},
                {"payload", {{"schema_version", "engine.motion_intent.v4"}}},
            }},
       }},
  };
  const auto parsed_update = ag99::runtime::parse_segment_motion_update(
      ag99::runtime::parse_envelope(update));
  assert(parsed_update.envelope.message_id == "m-pending");
  assert(parsed_update.motion.state
      == ag99::runtime::MotionSlot::State::Present);

  auto invalid = update;
  invalid["payload"]["motion"] = {{"state", "pending"}};
  bool rejected = false;
  try {
    (void)ag99::runtime::parse_segment_motion_update(
        ag99::runtime::parse_envelope(invalid));
  } catch (const ag99::runtime::ProtocolError&) {
    rejected = true;
  }
  assert(rejected);
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

ag99::runtime::Json make_incremental_event(
    std::string type,
    ag99::runtime::Json payload,
    std::string turn_id = "turn-1") {
  return ag99::runtime::build_envelope(
      type, payload, turn_id, "adapter", "event-1",
      "2026-10-01T00:00:00.000Z");
}

ag99::runtime::Json make_incremental_identity(
    std::string stream_id,
    std::uint64_t seq) {
  return {
      {"schema_version", "olv.incremental_output.v1"},
      {"turn_id", "turn-1"},
      {"core_turn_id", "core-1"},
      {"persona_result_id", "persona-1"},
      {"segment_message_id", "segment-1"},
      {"stream_id", std::move(stream_id)},
      {"segment_index", 0},
      {"seq", seq},
  };
}

void test_incremental_output_protocol() {
  auto start_payload = make_incremental_identity("text-1", 0);
  const auto start = ag99::runtime::parse_incremental_output_event(
      ag99::runtime::parse_envelope(make_incremental_event(
          "output.text_stream_start", start_payload)));
  assert(start.has_value());
  assert(start->kind == ag99::runtime::IncrementalOutputEventKind::Start);
  assert(start->resource == ag99::runtime::IncrementalOutputResource::Text);
  assert(start->identity.stream_id == "text-1");

  auto delta_payload = make_incremental_identity("text-1", 1);
  delta_payload["text"] = "你好";
  const auto delta = ag99::runtime::parse_incremental_output_event(
      ag99::runtime::parse_envelope(make_incremental_event(
          "output.text_stream_delta", delta_payload)));
  assert(delta.has_value());
  assert(delta->kind == ag99::runtime::IncrementalOutputEventKind::TextDelta);
  assert(delta->text == "你好");

  auto audio_start_payload = make_incremental_identity("audio-1", 0);
  audio_start_payload["encoding"] = "pcm16le";
  audio_start_payload["sample_rate"] = 32000;
  audio_start_payload["channels"] = 1;
  const auto audio_start = ag99::runtime::parse_incremental_output_event(
      ag99::runtime::parse_envelope(make_incremental_event(
          "output.audio_stream_start", audio_start_payload)));
  assert(audio_start.has_value());
  assert(audio_start->resource == ag99::runtime::IncrementalOutputResource::Audio);

  auto motion_payload = make_incremental_identity("motion-1", 1);
  motion_payload["motion_payload"] = {
      {"schema_version", "engine.motion_intent.v4"},
      {"actions", nlohmann::json::array()},
  };
  const auto motion = ag99::runtime::parse_incremental_output_event(
      ag99::runtime::parse_envelope(make_incremental_event(
          "output.motion_stream_update", motion_payload)));
  assert(motion.has_value());
  assert(motion->kind == ag99::runtime::IncrementalOutputEventKind::MotionUpdate);
  assert(motion->motion_payload.is_object());

  auto end_payload = make_incremental_identity("text-1", 2);
  end_payload["status"] = "completed";
  end_payload["text_length"] = 2;
  const auto end = ag99::runtime::parse_incremental_output_event(
      ag99::runtime::parse_envelope(make_incremental_event(
          "output.text_stream_end", end_payload)));
  assert(end.has_value());
  assert(end->status == ag99::runtime::IncrementalOutputStatus::Completed);
  assert(end->length == std::optional<std::uint64_t>(2));

  auto invalid_delta = make_incremental_identity("text-1", 1);
  bool rejected = false;
  try {
    (void)ag99::runtime::parse_incremental_output_event(
        ag99::runtime::parse_envelope(make_incremental_event(
            "output.text_stream_delta", invalid_delta)));
  } catch (const ag99::runtime::ProtocolError&) {
    rejected = true;
  }
  assert(rejected);
}

void test_incremental_output_audio_frame() {
  auto metadata = make_incremental_identity("audio-1", 1);
  metadata["sample_offset"] = 0;
  metadata["encoding"] = "pcm16le";
  metadata["sample_rate"] = 32000;
  metadata["channels"] = 1;
  const auto metadata_text = metadata.dump();
  std::vector<std::uint8_t> frame = {'A', 'G', '9', '9', 1, 2, 0, 0};
  const auto metadata_size = static_cast<std::uint32_t>(metadata_text.size());
  frame.push_back(static_cast<std::uint8_t>(metadata_size & 0xff));
  frame.push_back(static_cast<std::uint8_t>((metadata_size >> 8) & 0xff));
  frame.push_back(static_cast<std::uint8_t>((metadata_size >> 16) & 0xff));
  frame.push_back(static_cast<std::uint8_t>((metadata_size >> 24) & 0xff));
  frame.insert(frame.end(), metadata_text.begin(), metadata_text.end());
  frame.insert(frame.end(), {0x00, 0x00, 0x01, 0x00});

  const auto parsed = ag99::runtime::parse_output_audio_frame(frame);
  assert(parsed.identity.stream_id == "audio-1");
  assert(parsed.identity.seq == 1);
  assert(parsed.sample_offset == 0);
  assert(parsed.sample_rate == 32000);
  assert(parsed.channels == 1);
  assert(parsed.pcm.size() == 4);

  frame[5] = 1;
  bool rejected = false;
  try {
    (void)ag99::runtime::parse_output_audio_frame(frame);
  } catch (const ag99::runtime::ProtocolError&) {
    rejected = true;
  }
  assert(rejected);
}

void test_incremental_runtime_dispatch() {
  std::vector<ag99::runtime::IncrementalOutputEvent> events;
  std::vector<ag99::runtime::OutputAudioFrame> audio_frames;
  std::vector<std::string> errors;
  ag99::runtime::RuntimeProtocolSession session({
      .on_protocol_error = [&](std::string error) {
        errors.push_back(std::move(error));
      },
      .on_incremental_output_event =
          [&](ag99::runtime::IncrementalOutputEvent event) {
            events.push_back(std::move(event));
          },
      .on_incremental_audio_frame = [&](ag99::runtime::OutputAudioFrame frame) {
        audio_frames.push_back(std::move(frame));
      },
  });
  auto start = make_incremental_identity("text-1", 0);
  session.ingest_text(make_incremental_event(
      "output.text_stream_start", start).dump());
  assert(events.size() == 1);

  auto metadata = make_incremental_identity("audio-1", 1);
  metadata["sample_offset"] = 0;
  metadata["encoding"] = "pcm16le";
  metadata["sample_rate"] = 32000;
  metadata["channels"] = 1;
  const auto metadata_text = metadata.dump();
  std::vector<std::uint8_t> frame = {'A', 'G', '9', '9', 1, 2, 0, 0};
  const auto metadata_size = static_cast<std::uint32_t>(metadata_text.size());
  frame.insert(frame.end(), {
      static_cast<std::uint8_t>(metadata_size & 0xff),
      static_cast<std::uint8_t>((metadata_size >> 8) & 0xff),
      static_cast<std::uint8_t>((metadata_size >> 16) & 0xff),
      static_cast<std::uint8_t>((metadata_size >> 24) & 0xff),
  });
  frame.insert(frame.end(), metadata_text.begin(), metadata_text.end());
  frame.insert(frame.end(), {0x00, 0x00});
  session.ingest_binary(frame);
  assert(audio_frames.size() == 1);
  assert(errors.empty());
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
  std::vector<std::string> synthesized_turns;
  std::vector<std::string> finished_turns;
  std::vector<bool> finished_successes;
  std::vector<std::string> finished_reasons;
  std::vector<std::string> interrupted_turns;
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
      [&](std::string turn_id) { synthesized_turns.push_back(std::move(turn_id)); },
      [&](std::string turn_id, bool success, std::string reason) {
        finished_turns.push_back(std::move(turn_id));
        finished_successes.push_back(success);
        finished_reasons.push_back(std::move(reason));
      },
      [&](std::string turn_id) { interrupted_turns.push_back(std::move(turn_id)); },
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
      {"type", "control.synth_finished"},
      {"version", "v2"},
      {"message_id", "synth-finish-1"},
      {"timestamp", "2026-10-01T00:00:00.000Z"},
      {"turn_id", "turn-1"},
      {"source", "adapter"},
      {"payload", ag99::runtime::Json::object()},
  }.dump());
  assert((synthesized_turns == std::vector<std::string>{"turn-1"}));
  session.ingest_text(make_segment("m-after-synth", 2).dump());
  assert(ready_messages.size() == 2);
  assert(errors.size() == 2);
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
  assert((finished_successes == std::vector<bool>{true}));
  assert((finished_reasons == std::vector<std::string>{""}));
  session.ingest_text(make_segment("m-late", 2).dump());
  assert(ready_messages.size() == 2);
  assert(errors.size() == 3);
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
  assert(errors.size() == 4);

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
  assert((finished_turns == std::vector<std::string>{"turn-1"}));
  assert((interrupted_turns == std::vector<std::string>{"turn-2"}));
  session.ingest_text(make_segment("m-interrupted", 1, "adapter", "turn-2").dump());
  assert(ready_messages.size() == 3);
  assert(errors.size() == 5);
  assert(errors.back() == "segment rejected: segment_turn_interrupted");
  session.ingest_text(ag99::runtime::Json{
      {"type", "control.turn_finished"},
      {"version", "v2"},
      {"message_id", "turn-finish-interrupted"},
      {"timestamp", "2026-10-01T00:00:02.000Z"},
      {"turn_id", "turn-2"},
      {"source", "adapter"},
      {"payload", {{"success", false}, {"reason", "superseded_by_new_user_input"}}},
  }.dump());
  assert(errors.size() == 5);
  assert((finished_turns == std::vector<std::string>{"turn-1", "turn-2"}));
  assert((finished_successes == std::vector<bool>{true, false}));
  assert((finished_reasons
      == std::vector<std::string>{"", "superseded_by_new_user_input"}));

  session.ingest_text(ag99::runtime::Json{
      {"type", "control.turn_started"},
      {"version", "v2"},
      {"message_id", "turn-start-failed"},
      {"timestamp", "2026-10-01T00:00:03.000Z"},
      {"turn_id", "turn-failed"},
      {"source", "adapter"},
      {"payload", ag99::runtime::Json::object()},
  }.dump());
  session.ingest_text(ag99::runtime::Json{
      {"type", "control.turn_finished"},
      {"version", "v2"},
      {"message_id", "turn-finish-failed"},
      {"timestamp", "2026-10-01T00:00:03.000Z"},
      {"turn_id", "turn-failed"},
      {"source", "adapter"},
      {"payload", {{"success", false}, {"reason", "output_failed"}}},
  }.dump());
  assert((finished_turns
      == std::vector<std::string>{"turn-1", "turn-2", "turn-failed"}));
  assert((finished_successes == std::vector<bool>{true, false, false}));
  assert((finished_reasons == std::vector<std::string>{
      "", "superseded_by_new_user_input", "output_failed"}));

  session.ingest_text(ag99::runtime::Json{
      {"type", "control.turn_started"},
      {"version", "v2"},
      {"message_id", "turn-start-missing"},
      {"timestamp", "2026-10-01T00:00:00.000Z"},
      {"turn_id", nullptr},
      {"source", "adapter"},
      {"payload", ag99::runtime::Json::object()},
  }.dump());
  assert(errors.size() == 6);

  session.ingest_text("{\"type\":\"output.segment\",\"version\":\"v1\"}");
  assert(errors.size() == 7);
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

void test_desktop_settings_boundary() {
  std::vector<ag99::runtime::DesktopSettingsQuery> queries;
  std::vector<std::string> errors;
  ag99::runtime::RuntimeProtocolSession session({
      .on_protocol_error = [&](std::string error) {
        errors.push_back(std::move(error));
      },
      .on_desktop_settings_query = [&](ag99::runtime::DesktopSettingsQuery query) {
        queries.push_back(std::move(query));
      },
  });
  auto request = ag99::runtime::build_envelope(
      "system.desktop_settings_query",
      {{"request_id", " request-1 "},
       {"key", " live2d_physics_response_scale "},
       {"action", "set"},
       {"value", ""},
       {"extra", true}},
      std::nullopt,
      "adapter");
  session.ingest_text(request.dump());
  assert(errors.empty());
  assert(queries.size() == 1);
  assert(queries.front().request_id == "request-1");
  assert(queries.front().key == "live2d_physics_response_scale");
  assert(queries.front().action == "set");
  assert(queries.front().value == std::optional<std::string>(""));

  const auto response = ag99::runtime::build_system_desktop_settings_result({
      .request_id = queries.front().request_id,
      .key = queries.front().key,
      .entry = ag99::runtime::DesktopSettingsEntry{
          .value = "1",
          .options = {{"1", "Normal"}},
          .minimum = 0.5,
          .maximum = 2.0,
          .step = 0.05},
  });
  assert(response.at("type") == "system.desktop_settings_result");
  assert(response.at("source") == "frontend");
  assert(response.at("turn_id").is_null());
  assert(response.at("payload").at("ok") == true);
  assert(response.at("payload").at("value") == "1");
  assert(response.at("payload").at("options").at(0).at("id") == "1");
  assert(response.at("payload").at("minimum") == 0.5);
  assert(response.at("payload").at("maximum") == 2.0);
  assert(response.at("payload").at("step") == 0.05);

  request["payload"]["value"] = nullptr;
  session.ingest_text(request.dump());
  assert(queries.size() == 1);
  assert(errors.size() == 1);
  const auto rejected = ag99::runtime::build_system_desktop_settings_result({
      .request_id = "request-2",
      .key = "spout_enabled",
      .error = "desktop_setting_unsupported",
  });
  assert(rejected.at("payload").at("ok") == false);
  assert(rejected.at("payload").at("error") == "desktop_setting_unsupported");
  assert(!rejected.at("payload").contains("value"));
}

}  // namespace

int main() {
  test_envelope_and_segment();
  test_segment_rejection_boundaries();
  test_parameter_plan_motion_slot();
  test_pending_and_deferred_motion_slots();
  test_binary_audio_round_trip();
  test_incremental_output_protocol();
  test_incremental_output_audio_frame();
  test_incremental_runtime_dispatch();
  test_segment_reorder_and_duplicate_rejection();
  test_input_text_builder();
  test_runtime_session_dispatch();
  test_audio_control_builders();
  test_desktop_settings_boundary();
  return 0;
}
