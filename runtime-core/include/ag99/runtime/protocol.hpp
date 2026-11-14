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

#include "ag99/runtime/protocol_manifest.hpp"

namespace ag99::runtime {

using Json = nlohmann::json;

inline constexpr std::string_view kProtocolVersion =
    protocol_manifest::kProtocolVersion;
inline constexpr std::string_view kOutputSegmentSchema =
    protocol_manifest::kOutputSegmentSchema;
inline constexpr std::string_view kMotionIntentSchema =
    protocol_manifest::kMotionIntentSchema;
inline constexpr std::string_view kAudioCreditSchema =
    protocol_manifest::kAudioCreditSchema;
inline constexpr std::string_view kParameterPlanSchema =
    protocol_manifest::kParameterPlanSchema;
inline constexpr std::string_view kModelInfoSchema =
    protocol_manifest::kModelInfoSchema;
inline constexpr std::string_view kDesktopPresenceSchema =
    "ag99live.desktop_presence.v1";
inline constexpr std::string_view kDesktopObservationSchema =
    "ag99live.desktop_observation.v1";

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
  enum class State { Present, Pending, Absent, Failed };
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

struct SegmentMotionUpdate {
  ProtocolEnvelope envelope;
  std::string schema_version;
  MotionSlot motion;
};

struct ModelSync {
  ProtocolEnvelope envelope;
  Json payload;
};

struct ServerInfo {
  ProtocolEnvelope envelope;
  std::string ws_url;
  std::string http_base_url;
  bool auto_start_mic = false;
  std::string product_version;
  Json schema_manifest = Json::object();
};

struct DesktopSettingsSyncComplete {
  ProtocolEnvelope envelope;
};

struct PreActionEvent {
  ProtocolEnvelope envelope;
  std::string action;
  std::string request_id;
  Json motion = Json();
  std::optional<double> expires_at_epoch_ms;
};

struct DesktopObservationRequest {
  ProtocolEnvelope envelope;
  std::string request_id;
};

struct DesktopPresenceRequest {
  ProtocolEnvelope envelope;
  std::string request_id;
  std::string monitor_id;
  int idle_after_seconds = 300;
  int minimum_away_seconds = 60;
  int confirmation_seconds = 3;
};

struct IdleMotionEvent {
  ProtocolEnvelope envelope;
  Json motion = Json();
  double expires_at_epoch_ms = 0.0;
};

struct DesktopSettingsQuery {
  ProtocolEnvelope envelope;
  std::string request_id;
  std::string key;
  std::string action;
  std::optional<std::string> value;
};

struct DesktopSettingOption {
  std::string id;
  std::string label;
};

struct DesktopSettingsEntry {
  std::string value;
  std::vector<DesktopSettingOption> options;
  std::optional<double> minimum;
  std::optional<double> maximum;
  std::optional<double> step;
};

struct DesktopSettingsResult {
  std::string request_id;
  std::string key;
  std::optional<DesktopSettingsEntry> entry;
  std::string error;
};

struct AudioCredit {
  std::string core_turn_id;
  std::string persona_result_id;
  std::uint64_t released_bytes = 0;
  std::uint64_t released_frames = 0;
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

struct IncrementalIdentity {
  std::string turn_id;
  std::string core_turn_id;
  std::string persona_result_id;
  std::string segment_message_id;
  std::string stream_id;
  std::uint64_t segment_index = 0;
  std::uint64_t seq = 0;
};

enum class IncrementalOutputResource { Text, Audio, Motion };

enum class IncrementalOutputEventKind { Start, TextDelta, MotionUpdate, End };

enum class IncrementalOutputStatus { Completed, Failed, Cancelled };

struct IncrementalOutputEvent {
  ProtocolEnvelope envelope;
  IncrementalOutputResource resource = IncrementalOutputResource::Text;
  IncrementalOutputEventKind kind = IncrementalOutputEventKind::Start;
  IncrementalIdentity identity;
  std::string text;
  Json motion_payload = Json::object();
  IncrementalOutputStatus status = IncrementalOutputStatus::Completed;
  std::string reason;
  std::optional<std::uint64_t> length;
};

struct OutputAudioFrame {
  IncrementalIdentity identity;
  std::uint64_t sample_offset = 0;
  std::uint32_t sample_rate = 32000;
  std::uint32_t channels = 1;
  std::vector<std::uint8_t> pcm;
};

ProtocolEnvelope parse_envelope(const Json& raw);
ProtocolEnvelope parse_envelope_json(std::string_view raw);
OutputSegment parse_output_segment(const ProtocolEnvelope& envelope);
SegmentMotionUpdate parse_segment_motion_update(
    const ProtocolEnvelope& envelope);
ModelSync parse_model_sync(const ProtocolEnvelope& envelope);
ServerInfo parse_server_info(const ProtocolEnvelope& envelope);
DesktopSettingsSyncComplete parse_desktop_settings_sync_complete(
    const ProtocolEnvelope& envelope);
PreActionEvent parse_pre_action(const ProtocolEnvelope& envelope);
DesktopObservationRequest parse_desktop_observation_request(
    const ProtocolEnvelope& envelope);
DesktopPresenceRequest parse_desktop_presence_request(
    const ProtocolEnvelope& envelope);
IdleMotionEvent parse_idle_motion(const ProtocolEnvelope& envelope);
DesktopSettingsQuery parse_desktop_settings_query(
    const ProtocolEnvelope& envelope);

BinaryAudioChunkFrame parse_binary_audio_frame(std::span<const std::uint8_t> frame);
std::optional<IncrementalOutputEvent> parse_incremental_output_event(
    const ProtocolEnvelope& envelope);
OutputAudioFrame parse_output_audio_frame(
    std::span<const std::uint8_t> frame);
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

Json build_system_desktop_settings_result(
    const DesktopSettingsResult& result,
    std::optional<std::string_view> message_id = std::nullopt,
    std::optional<std::string_view> timestamp = std::nullopt);

Json build_system_desktop_runtime_settings(
    bool persona_segment_stream_enabled,
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

Json build_control_audio_credit(
    std::string_view turn_id,
    const AudioCredit& credit,
    std::optional<std::string_view> message_id = std::nullopt,
    std::optional<std::string_view> timestamp = std::nullopt);

std::string describe_segment(const OutputSegment& segment);

}  // namespace ag99::runtime
