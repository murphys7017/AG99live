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
#include "ag99/native/bilibili_live_runtime.hpp"
#include "ag99/native/segment_types.hpp"
#include "ag99/runtime/protocol.hpp"

namespace ag99::native {

// Host-facing callbacks are the only dependency from the runtime coordinator
// into the model/render host. The coordinator never receives a JSON callback
// or a direct Cubism object.
struct RuntimeCoordinatorCallbacks {
  std::function<void(ag99::runtime::ModelSync)> on_model_sync;
  std::function<void(ag99::runtime::PreActionEvent)> on_pre_action;
  std::function<void(ag99::runtime::DesktopObservationRequest)>
      on_desktop_observation_request;
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
  std::function<void()> reset_speech_signal;
  std::function<std::optional<AudioPlayback>(
      const std::string&, std::string&)> play_audio_url;
  std::function<void(std::optional<std::uint64_t>)> stop_current_audio;
  std::function<void()> stop_incremental_audio;
  std::function<std::optional<std::string>(std::string&)> capture_desktop_jpeg;
  AudioRuntime* audio_runtime = nullptr;
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
