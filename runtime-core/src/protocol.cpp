#include "ag99/runtime/protocol.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <iomanip>
#include <limits>
#include <random>
#include <ranges>
#include <sstream>
#include <unordered_set>

namespace ag99::runtime {
namespace {

constexpr std::size_t kAudioHeaderBytes = 12;
constexpr std::size_t kMaxMetadataBytes = 64 * 1024;
constexpr std::uint8_t kAudioFrameVersion = 1;
constexpr std::uint8_t kAudioFrameTypeChunk = 1;
constexpr std::array<char, 4> kAudioMagic = {'A', 'G', '9', '9'};

const Json& require_object(const Json& value, std::string_view path) {
  if (!value.is_object()) {
    throw ProtocolError(std::string(path) + " must be an object");
  }
  return value;
}

std::string require_string(
    const Json& object,
    std::string_view key,
    std::string_view path) {
  const auto it = object.find(std::string(key));
  if (it == object.end() || !it->is_string()) {
    throw ProtocolError(std::string(path) + "." + std::string(key) +
                        " must be a non-empty string");
  }
  const auto value = it->get<std::string>();
  if (value.empty()) {
    throw ProtocolError(std::string(path) + "." + std::string(key) +
                        " must be a non-empty string");
  }
  return value;
}

std::optional<std::string> optional_string(
    const Json& object,
    std::string_view key,
    std::string_view path) {
  const auto it = object.find(std::string(key));
  if (it == object.end() || it->is_null()) {
    return std::nullopt;
  }
  if (!it->is_string()) {
    throw ProtocolError(std::string(path) + "." + std::string(key) +
                        " must be a string or null");
  }
  const auto value = it->get<std::string>();
  return value.empty() ? std::nullopt : std::optional<std::string>(value);
}

std::int64_t require_non_negative_integer(
    const Json& object,
    std::string_view key,
    std::string_view path) {
  const auto it = object.find(std::string(key));
  if (it == object.end() || !it->is_number_integer()) {
    throw ProtocolError(std::string(path) + "." + std::string(key) +
                        " must be a non-negative integer");
  }
  const auto value = it->get<std::int64_t>();
  if (value < 0) {
    throw ProtocolError(std::string(path) + "." + std::string(key) +
                        " must be a non-negative integer");
  }
  return value;
}

std::uint32_t require_positive_u32(
    const Json& object,
    std::string_view key,
    std::string_view path) {
  const auto value = require_non_negative_integer(object, key, path);
  if (value <= 0 || value > UINT32_MAX) {
    throw ProtocolError(std::string(path) + "." + std::string(key) +
                        " must be a positive integer");
  }
  return static_cast<std::uint32_t>(value);
}

void validate_capture_mode(std::optional<std::string_view> capture_mode) {
  if (capture_mode.has_value()
      && *capture_mode != "manual"
      && *capture_mode != "ptt"
      && *capture_mode != "auto") {
    throw ProtocolError("capture_mode must be manual, ptt, or auto");
  }
}

void require_exact_keys(
    const Json& object,
    std::string_view path,
    std::initializer_list<std::string_view> expected) {
  std::unordered_set<std::string> allowed;
  for (const auto key : expected) {
    allowed.emplace(key);
  }
  for (const auto& [key, _] : object.items()) {
    if (!allowed.contains(key)) {
      throw ProtocolError(std::string(path) + "." + key + " is not allowed");
    }
  }
}

const Json& require_member(
    const Json& object,
    std::string_view key,
    std::string_view path) {
  const auto it = object.find(std::string(key));
  if (it == object.end()) {
    throw ProtocolError(std::string(path) + "." + std::string(key) +
                        " is required");
  }
  return *it;
}

bool is_http_url(const std::string& value) {
  return value.starts_with("http://") || value.starts_with("https://");
}

TextSlot parse_text_slot(const Json& value) {
  require_object(value, "payload.text");
  const auto state = require_string(value, "state", "payload.text");
  if (state == "absent") {
    require_exact_keys(value, "payload.text", {"state"});
    return {};
  }
  if (state == "present") {
    require_exact_keys(value, "payload.text", {"state", "content"});
    const auto content = require_string(value, "content", "payload.text");
    return TextSlot{TextSlot::State::Present, content, {}};
  }
  if (state == "failed") {
    require_exact_keys(value, "payload.text", {"state", "reason"});
    const auto reason = require_string(value, "reason", "payload.text");
    return TextSlot{TextSlot::State::Failed, {}, reason};
  }
  throw ProtocolError("payload.text.state is unsupported");
}

AudioSlot parse_audio_slot(const Json& value) {
  require_object(value, "payload.audio");
  const auto state = require_string(value, "state", "payload.audio");
  if (state == "absent") {
    require_exact_keys(value, "payload.audio", {"state"});
    return {};
  }
  if (state == "present") {
    require_exact_keys(value, "payload.audio", {"state", "url"});
    const auto url = require_string(value, "url", "payload.audio");
    if (!is_http_url(url)) {
      throw ProtocolError("payload.audio.url must be an absolute HTTP(S) URL");
    }
    return AudioSlot{AudioSlot::State::Present, url, {}};
  }
  if (state == "failed") {
    require_exact_keys(value, "payload.audio", {"state", "reason"});
    const auto reason = require_string(value, "reason", "payload.audio");
    return AudioSlot{AudioSlot::State::Failed, {}, reason};
  }
  throw ProtocolError("payload.audio.state is unsupported");
}

MotionSlot parse_motion_slot(const Json& value) {
  require_object(value, "payload.motion");
  const auto state = require_string(value, "state", "payload.motion");
  if (state == "absent") {
    require_exact_keys(value, "payload.motion", {"state"});
    return {};
  }
  if (state == "failed") {
    require_exact_keys(value, "payload.motion", {"state", "reason"});
    const auto reason = require_string(value, "reason", "payload.motion");
    return MotionSlot{MotionSlot::State::Failed, {}, {}, {}, Json::object(), reason};
  }
  if (state != "present") {
    throw ProtocolError("payload.motion.state is unsupported");
  }
  require_exact_keys(
      value,
      "payload.motion",
      {"state", "message_type", "mode", "source", "payload"});
  const auto message_type = require_string(value, "message_type", "payload.motion");
  const auto mode = require_string(value, "mode", "payload.motion");
  const auto source = require_string(value, "source", "payload.motion");
  const auto payload_it = value.find("payload");
  if (payload_it == value.end() || !payload_it->is_object()) {
    throw ProtocolError("payload.motion.payload must be an object");
  }
  const auto schema_it = payload_it->find("schema_version");
  if (schema_it == payload_it->end()
      || !schema_it->is_string()) {
    throw ProtocolError(
        "payload.motion must contain engine.motion_intent.v4 or engine.parameter_plan.v3");
  }
  const auto schema = schema_it->get<std::string>();
  const bool supported_motion_intent =
      message_type == "engine.motion_intent"
      && schema == kMotionIntentSchema;
  const bool supported_parameter_plan =
      message_type == "engine.parameter_plan"
      && schema == kParameterPlanSchema;
  if (!supported_motion_intent && !supported_parameter_plan) {
    throw ProtocolError(
        "payload.motion must contain engine.motion_intent.v4 or engine.parameter_plan.v3");
  }
  return MotionSlot{
      MotionSlot::State::Present,
      message_type,
      mode,
      source,
      *payload_it,
      {}};
}

SpeechSlot parse_speech_slot(const Json& value) {
  require_object(value, "payload.speech");
  const auto state = require_string(value, "state", "payload.speech");
  if (state == "absent") {
    require_exact_keys(value, "payload.speech", {"state"});
    return {};
  }
  if (state != "present") {
    throw ProtocolError("payload.speech.state is unsupported");
  }
  require_exact_keys(value, "payload.speech", {"state", "cues"});
  const auto cues_it = value.find("cues");
  if (cues_it == value.end() || !cues_it->is_array()
      || cues_it->empty() || cues_it->size() > 8) {
    throw ProtocolError("payload.speech.cues must contain 1 to 8 cues");
  }
  SpeechSlot slot;
  slot.state = SpeechSlot::State::Present;
  for (const auto& cue : *cues_it) {
    require_object(cue, "payload.speech.cues[]");
    require_exact_keys(
        cue,
        "payload.speech.cues[]",
        {"kind", "phrase_index", "position"});
    const auto kind = require_string(cue, "kind", "payload.speech.cues[]");
    const auto phrase_index =
        require_non_negative_integer(cue, "phrase_index", "payload.speech.cues[]");
    const auto position = require_string(cue, "position", "payload.speech.cues[]");
    static constexpr std::array<std::string_view, 6> kKinds = {
        "breath", "sigh", "laugh", "chuckle", "hesitate", "emphasis"};
    static constexpr std::array<std::string_view, 2> kPositions = {"before", "after"};
    if (std::ranges::find(kKinds, kind) == kKinds.end()
        || std::ranges::find(kPositions, position) == kPositions.end()) {
      throw ProtocolError("payload.speech.cues contains an unsupported cue");
    }
    slot.cues.push_back(SpeechCue{kind, phrase_index, position});
  }
  return slot;
}

std::string random_hex_id() {
  static thread_local std::mt19937_64 generator{std::random_device{}()};
  std::ostringstream stream;
  stream << std::hex << generator();
  return stream.str();
}

std::string utc_timestamp() {
  const auto now = std::chrono::system_clock::now();
  const auto time = std::chrono::system_clock::to_time_t(now);
  std::tm utc{};
#if defined(_WIN32)
  gmtime_s(&utc, &time);
#else
  gmtime_r(&time, &utc);
#endif
  const auto milliseconds =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          now.time_since_epoch()) % 1000;
  std::ostringstream stream;
  stream << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S")
         << "." << std::setfill('0') << std::setw(3) << milliseconds.count()
         << "Z";
  return stream.str();
}

void write_u16(std::vector<std::uint8_t>& output, std::uint16_t value) {
  output.push_back(static_cast<std::uint8_t>(value & 0xff));
  output.push_back(static_cast<std::uint8_t>((value >> 8) & 0xff));
}

void write_u32(std::vector<std::uint8_t>& output, std::uint32_t value) {
  for (unsigned shift = 0; shift < 32; shift += 8) {
    output.push_back(static_cast<std::uint8_t>((value >> shift) & 0xff));
  }
}

std::uint16_t read_u16(std::span<const std::uint8_t> bytes, std::size_t offset) {
  return static_cast<std::uint16_t>(bytes[offset])
      | static_cast<std::uint16_t>(bytes[offset + 1] << 8);
}

std::uint32_t read_u32(std::span<const std::uint8_t> bytes, std::size_t offset) {
  return static_cast<std::uint32_t>(bytes[offset])
      | (static_cast<std::uint32_t>(bytes[offset + 1]) << 8)
      | (static_cast<std::uint32_t>(bytes[offset + 2]) << 16)
      | (static_cast<std::uint32_t>(bytes[offset + 3]) << 24);
}

}  // namespace

ProtocolEnvelope parse_envelope(const Json& raw) {
  require_object(raw, "envelope");
  const auto type = require_string(raw, "type", "envelope");
  const auto version = require_string(raw, "version", "envelope");
  if (version != kProtocolVersion) {
    throw ProtocolError("envelope.version must be v2");
  }
  const auto message_id = require_string(raw, "message_id", "envelope");
  const auto timestamp = require_string(raw, "timestamp", "envelope");
  const auto source = require_string(raw, "source", "envelope");
  const auto payload_it = raw.find("payload");
  if (payload_it == raw.end() || !payload_it->is_object()) {
    throw ProtocolError("envelope.payload must be an object");
  }
  std::optional<std::string> turn_id;
  const auto turn_it = raw.find("turn_id");
  if (turn_it == raw.end() || turn_it->is_null()) {
    turn_id = std::nullopt;
  } else if (turn_it->is_string() && !turn_it->get<std::string>().empty()) {
    turn_id = turn_it->get<std::string>();
  } else {
    throw ProtocolError("envelope.turn_id must be a non-empty string or null");
  }
  return ProtocolEnvelope{
      type, version, message_id, timestamp, turn_id, source, *payload_it};
}

ProtocolEnvelope parse_envelope_json(std::string_view raw) {
  try {
    return parse_envelope(Json::parse(raw));
  } catch (const Json::exception& error) {
    throw ProtocolError(std::string("invalid JSON: ") + error.what());
  }
}

OutputSegment parse_output_segment(const ProtocolEnvelope& envelope) {
  if (envelope.type != "output.segment") {
    throw ProtocolError("expected output.segment envelope");
  }
  if (envelope.source != "adapter") {
    throw ProtocolError("output.segment.source must be adapter");
  }
  if (!envelope.turn_id.has_value()) {
    throw ProtocolError("output.segment requires turn_id");
  }
  require_exact_keys(
      envelope.payload,
      "payload",
      {"schema_version", "sequence", "text", "audio", "motion", "speech",
       "images", "speaker_name", "avatar"});
  const auto schema_version = require_string(
      envelope.payload, "schema_version", "payload");
  if (schema_version != kOutputSegmentSchema) {
    throw ProtocolError("payload.schema_version must be output.segment.v5");
  }
  const auto sequence =
      require_non_negative_integer(envelope.payload, "sequence", "payload");
  const auto text = parse_text_slot(
      require_member(envelope.payload, "text", "payload"));
  const auto audio = parse_audio_slot(
      require_member(envelope.payload, "audio", "payload"));
  if (audio.state == AudioSlot::State::Present
      && text.state != TextSlot::State::Present) {
    throw ProtocolError("payload.text must be present when audio is present");
  }
  const auto motion = parse_motion_slot(
      require_member(envelope.payload, "motion", "payload"));
  const auto speech = parse_speech_slot(
      require_member(envelope.payload, "speech", "payload"));

  const auto& images_value = require_member(envelope.payload, "images", "payload");
  if (!images_value.is_array()) {
    throw ProtocolError("payload.images must be an array");
  }
  std::vector<std::string> images;
  for (const auto& image : images_value) {
    if (!image.is_string()) {
      throw ProtocolError("payload.images must contain strings");
    }
    images.push_back(image.get<std::string>());
  }

  std::string speaker_name;
  std::string avatar;
  if (const auto it = envelope.payload.find("speaker_name");
      it != envelope.payload.end()) {
    if (!it->is_string()) {
      throw ProtocolError("payload.speaker_name must be a string");
    }
    speaker_name = it->get<std::string>();
  }
  if (const auto it = envelope.payload.find("avatar");
      it != envelope.payload.end()) {
    if (!it->is_string()) {
      throw ProtocolError("payload.avatar must be a string");
    }
    avatar = it->get<std::string>();
  }
  return OutputSegment{
      envelope,
      schema_version,
      sequence,
      text,
      audio,
      motion,
      speech,
      images,
      speaker_name,
      avatar};
}

ModelSync parse_model_sync(const ProtocolEnvelope& envelope) {
  if (envelope.type != "system.model_sync") {
    throw ProtocolError("expected system.model_sync envelope");
  }
  if (envelope.source != "adapter") {
    throw ProtocolError("system.model_sync.source must be adapter");
  }
  require_exact_keys(
      envelope.payload,
      "payload",
      {"model_info", "runtime_cache_errors"});
  const auto& model_info = require_member(
      envelope.payload, "model_info", "payload");
  require_object(model_info, "payload.model_info");
  const auto schema_version = require_string(
      model_info, "schema_version", "payload.model_info");
  if (schema_version != kModelInfoSchema) {
    throw ProtocolError("payload.model_info.schema_version must be live2d_scan.v4");
  }
  const auto selected_model = require_string(
      model_info, "selected_model", "payload.model_info");
  const auto& models = require_member(
      model_info, "models", "payload.model_info");
  if (!models.is_array() || models.empty()) {
    throw ProtocolError("payload.model_info.models must be a non-empty array");
  }
  for (const auto& model : models) {
    require_object(model, "payload.model_info.models[]");
    require_string(model, "name", "payload.model_info.models[]");
    if (model.contains("semantic_axis_profile")
        && !model.at("semantic_axis_profile").is_null()
        && !model.at("semantic_axis_profile").is_object()) {
      throw ProtocolError(
          "payload.model_info.models[].semantic_axis_profile must be an object or null");
    }
  }
  if (selected_model.empty()) {
    throw ProtocolError("payload.model_info.selected_model must be non-empty");
  }
  const auto& cache_errors = require_member(
      envelope.payload, "runtime_cache_errors", "payload");
  if (!cache_errors.is_object()) {
    throw ProtocolError("payload.runtime_cache_errors must be an object");
  }
  return ModelSync{envelope, envelope.payload};
}

BinaryAudioChunkFrame parse_binary_audio_frame(
    std::span<const std::uint8_t> frame) {
  if (frame.size() < kAudioHeaderBytes) {
    throw ProtocolError("binary audio frame is too short");
  }
  if (!std::equal(kAudioMagic.begin(), kAudioMagic.end(), frame.begin())) {
    throw ProtocolError("binary audio frame has invalid magic");
  }
  if (frame[4] != kAudioFrameVersion) {
    throw ProtocolError("binary audio frame version is unsupported");
  }
  if (frame[5] != kAudioFrameTypeChunk) {
    throw ProtocolError("binary audio frame type is unsupported");
  }
  if (read_u16(frame, 6) != 0) {
    throw ProtocolError("binary audio frame flags are unsupported");
  }
  const auto metadata_size = read_u32(frame, 8);
  if (metadata_size == 0 || metadata_size > kMaxMetadataBytes
      || kAudioHeaderBytes + metadata_size > frame.size()) {
    throw ProtocolError("binary audio frame metadata size is invalid");
  }
  Json metadata;
  try {
    metadata = Json::parse(
        frame.subspan(kAudioHeaderBytes, metadata_size).begin(),
        frame.subspan(kAudioHeaderBytes, metadata_size).end());
  } catch (const Json::exception& error) {
    throw ProtocolError(std::string("invalid binary audio metadata: ") + error.what());
  }
  require_object(metadata, "audio metadata");
  const auto stream_id = require_string(metadata, "stream_id", "audio metadata");
  const auto turn_id = optional_string(metadata, "turn_id", "audio metadata");
  const auto sequence =
      require_non_negative_integer(metadata, "seq", "audio metadata");
  const auto encoding = require_string(metadata, "encoding", "audio metadata");
  if (encoding != "pcm16le") {
    throw ProtocolError("audio metadata.encoding must be pcm16le");
  }
  const auto sample_rate = require_positive_u32(metadata, "sample_rate", "audio metadata");
  const auto channels = require_positive_u32(metadata, "channels", "audio metadata");
  if (channels != 1) {
    throw ProtocolError("audio metadata.channels must be 1");
  }
  std::optional<std::string> capture_mode;
  if (const auto it = metadata.find("capture_mode"); it != metadata.end()) {
    if (!it->is_string()) {
      throw ProtocolError("audio metadata.capture_mode must be a string");
    }
    capture_mode = it->get<std::string>();
    if (*capture_mode != "manual" && *capture_mode != "ptt"
        && *capture_mode != "auto") {
      throw ProtocolError("audio metadata.capture_mode is unsupported");
    }
  }
  const auto payload_start = kAudioHeaderBytes + metadata_size;
  if (payload_start == frame.size()) {
    throw ProtocolError("binary audio payload is empty");
  }
  return BinaryAudioChunkFrame{
      AudioChunkMetadata{
          stream_id,
          turn_id,
          static_cast<std::uint64_t>(sequence),
          encoding,
          sample_rate,
          channels,
          capture_mode},
      std::vector<std::uint8_t>(frame.begin() + payload_start, frame.end())};
}

std::vector<std::uint8_t> build_binary_audio_frame(
    const AudioChunkMetadata& metadata,
    std::span<const std::uint8_t> payload) {
  if (metadata.stream_id.empty() || metadata.encoding != "pcm16le"
      || metadata.sample_rate == 0 || metadata.channels != 1
      || payload.empty()) {
    throw ProtocolError("invalid binary audio frame input");
  }
  Json metadata_json = {
      {"stream_id", metadata.stream_id},
      {"seq", metadata.sequence},
      {"encoding", metadata.encoding},
      {"sample_rate", metadata.sample_rate},
      {"channels", metadata.channels},
  };
  if (metadata.turn_id.has_value()) {
    metadata_json["turn_id"] = *metadata.turn_id;
  }
  if (metadata.capture_mode.has_value()) {
    metadata_json["capture_mode"] = *metadata.capture_mode;
  }
  const auto metadata_text = metadata_json.dump();
  if (metadata_text.size() > std::numeric_limits<std::uint32_t>::max()) {
    throw ProtocolError("binary audio metadata is too large");
  }
  std::vector<std::uint8_t> output;
  output.reserve(kAudioHeaderBytes + metadata_text.size() + payload.size());
  output.insert(output.end(), kAudioMagic.begin(), kAudioMagic.end());
  output.push_back(kAudioFrameVersion);
  output.push_back(kAudioFrameTypeChunk);
  write_u16(output, 0);
  write_u32(output, static_cast<std::uint32_t>(metadata_text.size()));
  output.insert(output.end(), metadata_text.begin(), metadata_text.end());
  output.insert(output.end(), payload.begin(), payload.end());
  return output;
}

Json build_envelope(
    std::string_view type,
    const Json& payload,
    std::optional<std::string_view> turn_id,
    std::string_view source,
    std::optional<std::string_view> message_id,
    std::optional<std::string_view> timestamp) {
  if (type.empty() || source.empty() || !payload.is_object()) {
    throw ProtocolError("invalid envelope builder input");
  }
  Json envelope = {
      {"type", type},
      {"version", kProtocolVersion},
      {"message_id", message_id.has_value() ? std::string(*message_id) : random_hex_id()},
      {"timestamp", timestamp.has_value() ? std::string(*timestamp) : utc_timestamp()},
      {"turn_id", turn_id.has_value() ? Json(std::string(*turn_id)) : Json(nullptr)},
      {"source", source},
      {"payload", payload},
  };
  return envelope;
}

Json build_input_text(
    std::string_view text,
    const std::vector<std::string>& images,
    std::optional<std::string_view> turn_id,
    std::optional<std::string_view> message_id,
    std::optional<std::string_view> timestamp) {
  if (text.empty()) {
    throw ProtocolError("input.text requires non-empty text");
  }
  Json payload = {{"text", text}, {"images", images}};
  return build_envelope(
      "input.text",
      payload,
      turn_id,
      "frontend",
      message_id,
      timestamp);
}

Json build_input_audio_stream_start(
    std::string_view stream_id,
    std::string_view stream_source,
    std::uint32_t sample_rate,
    std::uint32_t channels,
    std::optional<std::string_view> capture_mode,
    std::optional<std::string_view> device_id,
    std::optional<std::string_view> turn_id,
    std::optional<std::string_view> message_id,
    std::optional<std::string_view> timestamp) {
  if (stream_id.empty() || stream_source.empty() || sample_rate == 0
      || channels != 1) {
    throw ProtocolError("invalid input.audio_stream_start builder input");
  }
  validate_capture_mode(capture_mode);
  Json payload = {
      {"stream_id", stream_id},
      {"source", stream_source},
      {"encoding", "pcm16le"},
      {"sample_rate", sample_rate},
      {"channels", channels},
  };
  if (capture_mode.has_value()) {
    payload["capture_mode"] = *capture_mode;
  }
  if (device_id.has_value()) {
    if (device_id->empty()) {
      throw ProtocolError("device_id must be non-empty when provided");
    }
    payload["device_id"] = *device_id;
  }
  return build_envelope(
      "input.audio_stream_start",
      payload,
      turn_id,
      "frontend",
      message_id,
      timestamp);
}

Json build_input_audio_stream_end(
    std::string_view stream_id,
    std::string_view reason,
    std::optional<bool> dropped,
    std::optional<std::uint64_t> last_sequence,
    std::optional<std::string_view> capture_mode,
    const std::vector<std::string>& images,
    std::optional<bool> desktop_snapshot_requested,
    std::optional<std::string_view> turn_id,
    std::optional<std::string_view> message_id,
    std::optional<std::string_view> timestamp) {
  if (stream_id.empty() || reason.empty()
      || (last_sequence.has_value()
          && *last_sequence > static_cast<std::uint64_t>(
              std::numeric_limits<std::int64_t>::max()))) {
    throw ProtocolError("invalid input.audio_stream_end builder input");
  }
  validate_capture_mode(capture_mode);
  Json payload = {
      {"stream_id", stream_id},
      {"reason", reason},
      {"images", images},
  };
  if (dropped.has_value()) {
    payload["dropped"] = *dropped;
  }
  if (last_sequence.has_value()) {
    payload["last_seq"] = *last_sequence;
  }
  if (capture_mode.has_value()) {
    payload["capture_mode"] = *capture_mode;
  }
  if (desktop_snapshot_requested.has_value()) {
    payload["desktop_snapshot_requested"] = *desktop_snapshot_requested;
  }
  return build_envelope(
      "input.audio_stream_end",
      payload,
      turn_id,
      "frontend",
      message_id,
      timestamp);
}

Json build_control_playback_finished(
    std::string_view turn_id,
    bool success,
    std::optional<std::string_view> reason,
    std::optional<std::string_view> message_id,
    std::optional<std::string_view> timestamp) {
  if (turn_id.empty()) {
    throw ProtocolError("control.playback_finished requires turn_id");
  }
  Json payload = {{"success", success}};
  if (reason.has_value()) {
    if (reason->empty()) {
      throw ProtocolError("reason must be non-empty when provided");
    }
    payload["reason"] = *reason;
  }
  return build_envelope(
      "control.playback_finished",
      payload,
      turn_id,
      "frontend",
      message_id,
      timestamp);
}

std::string describe_segment(const OutputSegment& segment) {
  std::ostringstream stream;
  stream << "turn=" << *segment.envelope.turn_id
         << " message=" << segment.envelope.message_id
         << " sequence=" << segment.sequence
         << " text=" << (segment.text.state == TextSlot::State::Present ? "present" : "absent")
         << " audio=" << (segment.audio.state == AudioSlot::State::Present ? "present" : "absent")
         << " motion=" << (segment.motion.state == MotionSlot::State::Present ? "present" : "absent");
  return stream.str();
}

}  // namespace ag99::runtime
