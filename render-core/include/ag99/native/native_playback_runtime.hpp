#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "ag99/native/audio_runtime.hpp"
#include "ag99/native/playback_ledger.hpp"

namespace ag99::native {

enum class NativePlaybackDispatchResult {
  Dispatched,
  Stale,
  Unavailable,
};

// Owns the audio worker and the execution side of native playback. The
// coordinator supplies ledger and protocol callbacks, so this runtime does
// not need to know about websocket/session state or model objects.
struct NativePlaybackRuntimeServices {
  AudioRuntime* audio_runtime = nullptr;
  std::function<bool()> closing;
  std::function<std::uint64_t()> connection_generation;
  std::function<std::uint64_t()> pending_closed_generation;
  std::function<double()> now_seconds;
  std::function<std::optional<AudioPlayback>(
      const std::string&, std::string&)> play_audio_url;
  std::function<void(std::optional<std::uint64_t>)> stop_current_audio;
  std::function<void()> stop_incremental_audio;
  std::function<void()> reset_speech_signal;
  std::function<bool(
      const ag99::runtime::OutputAudioFrame&,
      std::uint64_t,
      std::uint64_t)> send_incremental_audio_credit;
  std::function<void(
      const ag99::runtime::IncrementalIdentity&,
      std::string_view)> fail_incremental_audio;
  std::function<void(
      const ag99::runtime::IncrementalIdentity&,
      NativeSegmentClock,
      bool,
      std::string_view)> complete_incremental_audio;
  std::function<bool(const AudioQueueItem&)> is_segment_playback_open;
  std::function<std::optional<ag99::runtime::MotionSlot>(
      const AudioQueueItem&, const NativeSegmentClock&)>
      activate_audio_segment;
  std::function<void(
      const std::string&,
      const std::string&,
      const NativeSegmentClock&,
      ag99::runtime::MotionSlot)> apply_motion_update;
  std::function<void(
      const AudioQueueItem&,
      bool,
      std::string_view)> complete_audio_segment;
  std::function<void(NativeSegmentTerminal)> complete_motion_segment;
  std::function<void()> process_pending_transport_closed;
  std::function<NativePlaybackDispatchResult(
      ag99::runtime::OutputSegment,
      NativeSegmentClock)> dispatch_output_segment;
  std::function<void(const std::string&, std::uint64_t)>
      try_send_playback_acknowledgement;
};

class NativePlaybackRuntime final {
public:
  explicit NativePlaybackRuntime(NativePlaybackRuntimeServices services);
  ~NativePlaybackRuntime();

  NativePlaybackRuntime(const NativePlaybackRuntime&) = delete;
  NativePlaybackRuntime& operator=(const NativePlaybackRuntime&) = delete;

  void Start();
  void Join();

private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace ag99::native
