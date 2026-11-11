#pragma once

#include <windows.h>
#include <mmsystem.h>

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "ag99/audio/audio_source.hpp"
#include "ag99/audio/speech_signal.hpp"
#include "ag99/audio/wav_audio.hpp"

namespace ag99::native {

struct AudioQueueState;

struct AudioPlayback {
  double duration_seconds = 0.0;
  std::uint64_t serial = 0;
  double started_at_seconds = 0.0;
};

class NativeAudioOutput final {
public:
  NativeAudioOutput() = default;
  ~NativeAudioOutput();

  NativeAudioOutput(const NativeAudioOutput&) = delete;
  NativeAudioOutput& operator=(const NativeAudioOutput&) = delete;

  bool Start(
      const ag99::audio::PcmWavInfo& info,
      std::vector<std::uint8_t> bytes);
  void Stop() noexcept;

private:
  HWAVEOUT handle_ = nullptr;
  WAVEHDR header_{};
  std::vector<std::uint8_t> bytes_;
  bool prepared_ = false;
};

class NativePcmStreamOutput final {
  struct Buffer {
    std::vector<std::uint8_t> bytes;
    WAVEHDR header{};
    bool prepared = false;
    bool completed = false;
  };

public:
  NativePcmStreamOutput() = default;
  ~NativePcmStreamOutput();

  NativePcmStreamOutput(const NativePcmStreamOutput&) = delete;
  NativePcmStreamOutput& operator=(const NativePcmStreamOutput&) = delete;

  bool Start(std::uint32_t sample_rate, std::uint16_t channels = 1);
  bool Append(std::span<const std::uint8_t> pcm);
  bool WaitForDrain(
      std::chrono::milliseconds timeout = std::chrono::seconds(5));
  void Stop() noexcept;

private:
  static constexpr std::size_t kMaxBuffers = 64;

  static void CALLBACK WaveOutProc(
      HWAVEOUT,
      UINT message,
      DWORD_PTR instance,
      DWORD_PTR parameter,
      DWORD_PTR);
  void OnBufferDone(WAVEHDR* header);
  void ReapCompletedLocked();

  HWAVEOUT handle_ = nullptr;
  std::uint16_t block_align_ = 2;
  bool stopping_ = false;
  std::mutex mutex_;
  std::condition_variable condition_;
  std::deque<std::shared_ptr<Buffer>> buffers_;
};

class AudioRuntime final {
public:
  AudioRuntime();
  ~AudioRuntime();

  AudioRuntime(const AudioRuntime&) = delete;
  AudioRuntime& operator=(const AudioRuntime&) = delete;

  std::optional<AudioPlayback> PlayAudioUrl(
      const std::string& url,
      std::string& failure_reason);
  void StopCurrentAudio(
      std::optional<std::uint64_t> expected_serial = std::nullopt);
  void StopIncrementalAudio();
  void UpdateAudioLevel(float delta_seconds, double now);
  float SpeechAudioGain(std::string_view axis_id) const;
  float SpeechLipSyncIntensity() const;
  void ResetSpeechSignal();

  NativeAudioOutput& audio_output() noexcept { return audio_output_; }
  NativePcmStreamOutput& incremental_audio_output() noexcept {
    return incremental_audio_output_;
  }
  std::mutex& incremental_audio_output_mutex() noexcept {
    return incremental_audio_output_mutex_;
  }
  std::atomic<double>& audio_end_seconds() noexcept {
    return audio_end_seconds_;
  }
  std::atomic<double>& audio_start_seconds() noexcept {
    return audio_start_seconds_;
  }
  std::atomic<float>& audio_level() noexcept { return audio_level_; }
  std::atomic<std::uint64_t>& audio_serial() noexcept {
    return audio_serial_;
  }
  std::mutex& audio_signal_mutex() noexcept { return audio_signal_mutex_; }
  std::vector<float>& audio_rms() noexcept { return audio_rms_; }
  AudioQueueState& queue() noexcept { return *queue_; }

private:
  NativeAudioOutput audio_output_;
  NativePcmStreamOutput incremental_audio_output_;
  std::mutex incremental_audio_output_mutex_;
  std::atomic<double> audio_end_seconds_{0.0};
  std::atomic<double> audio_start_seconds_{0.0};
  std::atomic<float> audio_level_{0.0f};
  std::atomic<std::uint64_t> audio_serial_{0};
  std::mutex audio_output_mutex_;
  std::mutex audio_signal_mutex_;
  std::vector<float> audio_rms_;
  ag99::audio::SpeechSignalRuntime speech_signal_;
  std::unique_ptr<AudioQueueState> queue_;
};

}  // namespace ag99::native
