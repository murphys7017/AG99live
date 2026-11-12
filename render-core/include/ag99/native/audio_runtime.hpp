#pragma once

#include <windows.h>
#include <mmsystem.h>

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
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
#include "ag99/native/playback_ledger.hpp"

namespace ag99::native {

struct AudioQueueState;

struct AudioQueueWork {
  std::optional<PlaybackAcknowledgementItem> acknowledgement;
  std::optional<IncrementalAudioJob> incremental;
  std::optional<AudioQueueItem> segment;
};

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
  void SetVolume(float volume) noexcept;
  void Stop() noexcept;

private:
  HWAVEOUT handle_ = nullptr;
  WAVEHDR header_{};
  std::vector<std::uint8_t> bytes_;
  bool prepared_ = false;
  float volume_ = 1.0f;
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
  void SetVolume(float volume) noexcept;
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
  float volume_ = 1.0f;
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
  bool StartIncrementalAudioOutput(std::uint32_t sample_rate,
                                   std::uint16_t channels = 1);
  bool AppendIncrementalAudio(std::span<const std::uint8_t> pcm);
  bool DrainIncrementalAudio(
      std::chrono::milliseconds timeout = std::chrono::seconds(5));
  void SetSpeechVolume(float volume) noexcept;
  float SpeechVolume() const noexcept { return speech_volume_.load(); }
  void UpdateAudioLevel(float delta_seconds, double now);
  float SpeechAudioGain(std::string_view axis_id) const;
  float SpeechLipSyncIntensity() const;
  void ResetSpeechSignal();
  double AudioEndSeconds() const noexcept { return audio_end_seconds_.load(); }
  double AudioStartSeconds() const noexcept { return audio_start_seconds_.load(); }
  float AudioLevel() const noexcept { return audio_level_.load(); }
  std::uint64_t AudioSerial() const noexcept { return audio_serial_.load(); }
  std::uint64_t NextAudioSerial() noexcept {
    return audio_serial_.fetch_add(1) + 1;
  }
  void SetAudioClock(double start_seconds, double end_seconds) noexcept {
    audio_start_seconds_.store(start_seconds);
    audio_end_seconds_.store(end_seconds);
  }
  void SetAudioLevel(float level) noexcept { audio_level_.store(level); }
  void ResetAudioRms();
  void AppendAudioRms(float rms);

  // Playback queue ownership stays inside AudioRuntime. The coordinator
  // submits work and consumes opaque batches without touching queue locks or
  // mutable ledger fields directly.
  void EnqueueSegment(AudioQueueItem item);
  bool EnqueueIncremental(IncrementalAudioJob job,
                          std::size_t max_bytes,
                          std::size_t max_frames);
  void EnqueueAcknowledgement(PlaybackAcknowledgementItem item);
  bool WaitAndTakeWork(AudioQueueWork& work,
                       const std::function<bool()>& stop_requested);
  std::optional<std::uint64_t> ClearTurnQueues(std::string_view turn_id);
  void ClearAllQueues();
  void NotifyQueueOne() noexcept;
  void NotifyQueueAll() noexcept;
  void SetCurrentAudio(std::string turn_id,
                       std::string message_id,
                       std::uint64_t generation,
                       std::uint64_t serial);
  void ClearCurrentAudioIfMatches(std::string_view turn_id,
                                  std::string_view message_id,
                                  std::uint64_t generation,
                                  std::uint64_t serial);

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
  std::atomic<float> speech_volume_{1.0f};
  std::unique_ptr<AudioQueueState> queue_;
};

}  // namespace ag99::native
