#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

namespace ag99::runtime {

using Json = nlohmann::json;

inline constexpr std::string_view kProtocolVersion = "v2";
inline constexpr std::string_view kOutputSegmentSchema = "output.segment.v5";
inline constexpr std::string_view kMotionIntentSchema = "engine.motion_intent.v4";
inline constexpr std::string_view kParameterPlanSchema = "engine.parameter_plan.v3";
inline constexpr std::string_view kModelInfoSchema = "live2d_scan.v4";

class ProtocolError final : public std::runtime_error {
 public:
  explicit ProtocolError(const std::string& message) : std::runtime_error(message) {}
};

struct ProtocolEnvelope {
  std::string type;
  std::string version;
  std::string message_id;
  std::string timestamp;
  std::optional<std::string> turn_id;
  std::string source;
  Json payload;
};

struct TextSlot {
  enum class State { Present, Absent, Failed };
  State state = State::Absent;
  std::string content;
  std::string reason;
};

struct AudioSlot {
  enum class State { Present, Absent, Failed };
  State state = State::Absent;
  std::string url;
  std::string reason;
};

struct MotionSlot {
  enum class State { Present, Absent, Failed };
  State state = State::Absent;
  std::string message_type;
  std::string mode;
  std::string source;
  Json payload = Json::object();
  std::string reason;
};

struct SpeechCue {
  std::string kind;
  std::int64_t phrase_index = 0;
  std::string position;
};

struct SpeechSlot {
  enum class State { Present, Absent };
  State state = State::Absent;
  std::vector<SpeechCue> cues;
};

struct OutputSegment {
  ProtocolEnvelope envelope;
  std::string schema_version;
  std::int64_t sequence = 0;
  TextSlot text;
  AudioSlot audio;
  MotionSlot motion;
  SpeechSlot speech;
  std::vector<std::string> images;
  std::string speaker_name;
  std::string avatar;
};

struct ModelSync {
  ProtocolEnvelope envelope;
  Json payload;
};

struct AudioChunkMetadata {
  std::string stream_id;
  std::optional<std::string> turn_id;
  std::uint64_t sequence = 0;
  std::string encoding;
  std::uint32_t sample_rate = 0;
  std::uint32_t channels = 0;
  std::optional<std::string> capture_mode;
};

struct BinaryAudioChunkFrame {
  AudioChunkMetadata metadata;
  std::vector<std::uint8_t> payload;
};

ProtocolEnvelope parse_envelope(const Json& raw);
ProtocolEnvelope parse_envelope_json(std::string_view raw);
OutputSegment parse_output_segment(const ProtocolEnvelope& envelope);
ModelSync parse_model_sync(const ProtocolEnvelope& envelope);

BinaryAudioChunkFrame parse_binary_audio_frame(std::span<const std::uint8_t> frame);
std::vector<std::uint8_t> build_binary_audio_frame(
    const AudioChunkMetadata& metadata,
    std::span<const std::uint8_t> payload);

Json build_envelope(
    std::string_view type,
    const Json& payload,
    std::optional<std::string_view> turn_id,
    std::string_view source,
    std::optional<std::string_view> message_id = std::nullopt,
    std::optional<std::string_view> timestamp = std::nullopt);

Json build_input_text(
    std::string_view text,
    const std::vector<std::string>& images = {},
    std::optional<std::string_view> turn_id = std::nullopt,
    std::optional<std::string_view> message_id = std::nullopt,
    std::optional<std::string_view> timestamp = std::nullopt);

Json build_input_audio_stream_start(
    std::string_view stream_id,
    std::string_view stream_source,
    std::uint32_t sample_rate,
    std::uint32_t channels = 1,
    std::optional<std::string_view> capture_mode = std::nullopt,
    std::optional<std::string_view> device_id = std::nullopt,
    std::optional<std::string_view> turn_id = std::nullopt,
    std::optional<std::string_view> message_id = std::nullopt,
    std::optional<std::string_view> timestamp = std::nullopt);

Json build_input_audio_stream_end(
    std::string_view stream_id,
    std::string_view reason,
    std::optional<bool> dropped = std::nullopt,
    std::optional<std::uint64_t> last_sequence = std::nullopt,
    std::optional<std::string_view> capture_mode = std::nullopt,
    const std::vector<std::string>& images = {},
    std::optional<bool> desktop_snapshot_requested = std::nullopt,
    std::optional<std::string_view> turn_id = std::nullopt,
    std::optional<std::string_view> message_id = std::nullopt,
    std::optional<std::string_view> timestamp = std::nullopt);

Json build_control_playback_finished(
    std::string_view turn_id,
    bool success = true,
    std::optional<std::string_view> reason = std::nullopt,
    std::optional<std::string_view> message_id = std::nullopt,
    std::optional<std::string_view> timestamp = std::nullopt);

std::string describe_segment(const OutputSegment& segment);

}  // namespace ag99::runtime
