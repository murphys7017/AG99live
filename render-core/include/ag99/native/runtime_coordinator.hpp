#pragma once

#include <cstdint>
#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "ag99/native/audio_runtime.hpp"
#include "ag99/runtime/protocol.hpp"

namespace ag99::native {

// Render-host metadata shared by the audio and motion sides of one output
// segment. It is intentionally outside the wire protocol: the adapter owns
// protocol identities, while the coordinator owns local playback timing.
struct NativeSegmentClock {
  std::string turn_id;
  std::string message_id;
  std::int64_t sequence = 0;
  double started_at_seconds = 0.0;
  double duration_seconds = 0.0;
  std::uint64_t audio_serial = 0;
  std::uint64_t generation = 0;
};

struct NativeSegmentTerminal {
  NativeSegmentClock clock;
  bool success = false;
  std::string reason;
};

// Host-facing callbacks are the only dependency from the runtime coordinator
// into the model/render host. The coordinator never receives a JSON callback
// or a direct Cubism object.
struct RuntimeCoordinatorCallbacks {
  std::function<void(ag99::runtime::ModelSync)> on_model_sync;
  std::function<void(
      ag99::runtime::OutputSegment,
      std::optional<NativeSegmentClock>)> on_output_segment;
  std::function<void(std::uint64_t)> on_output_segment_reset;
  std::function<void(const std::string&)> on_turn_started;
  std::function<void(const std::string&, bool, const std::string&)>
      on_turn_finished;
  std::function<void(const std::string&)> on_turn_interrupted;
  std::function<ag99::runtime::DesktopSettingsResult(
      const ag99::runtime::DesktopSettingsQuery&)>
      on_desktop_settings_query;
};

struct RuntimeCoordinatorServices {
  std::function<bool()> native_incremental_output_enabled;
  std::function<void()> notify_input_connection_changed;
  std::function<void()> notify_input_runtime_state_changed;
  std::function<double()> now_seconds;
  std::function<std::wstring(std::string_view)> widen_utf8;
  std::function<std::string(std::string)> trim_ascii_text;
  std::function<void(std::wstring)> set_preview_text;
  std::function<void(std::wstring)> set_status_text;
  std::function<void()> reset_input_disconnected;
  std::function<void(bool)> set_feedback_available;
  std::function<void(bool)> set_feedback_approved;
  std::function<bool()> runtime_connected;
  std::function<void(bool)> set_runtime_connected;
  std::function<void(float, double)> update_audio_level;
  std::function<float(std::string_view)> speech_audio_gain;
  std::function<void()> reset_speech_signal;
  std::function<std::optional<AudioPlayback>(
      const std::string&, std::string&)> play_audio_url;
  std::function<void(std::optional<std::uint64_t>)> stop_current_audio;
  std::function<void()> stop_incremental_audio;
  NativeAudioOutput* audio_output = nullptr;
  NativePcmStreamOutput* incremental_audio_output = nullptr;
  std::mutex* incremental_audio_output_mutex = nullptr;
  std::atomic<double>* audio_end_seconds = nullptr;
  std::atomic<double>* audio_start_seconds = nullptr;
  std::atomic<float>* audio_level = nullptr;
  std::atomic<std::uint64_t>* audio_serial = nullptr;
  std::mutex* audio_signal_mutex = nullptr;
  std::vector<float>* audio_rms = nullptr;
  AudioQueueState* audio_queue = nullptr;
};

class NativeRuntimeCoordinator final {
public:
  NativeRuntimeCoordinator(
      RuntimeCoordinatorCallbacks callbacks,
      RuntimeCoordinatorServices services);
  ~NativeRuntimeCoordinator();

  NativeRuntimeCoordinator(const NativeRuntimeCoordinator&) = delete;
  NativeRuntimeCoordinator& operator=(const NativeRuntimeCoordinator&) = delete;

  bool Connect(const std::string& url);
  bool Reconnect();
  bool SendText(std::string_view text);
  bool InterruptCurrentTurn();
  bool ApproveLatestAssistantSegment();
  bool ToggleMicrophone();
  bool MicrophoneRunning() const noexcept;
  void NotifyMotionTerminal(NativeSegmentTerminal terminal);
  void Close();

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace ag99::native
