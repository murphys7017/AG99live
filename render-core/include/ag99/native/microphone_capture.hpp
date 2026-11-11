#pragma once

#include <windows.h>
#include <mmsystem.h>

#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace ag99::runtime {
class WinHttpWebSocketClient;
}

namespace ag99::native {

class MicrophoneCapture final {
public:
  explicit MicrophoneCapture(
      ag99::runtime::WinHttpWebSocketClient& websocket);
  ~MicrophoneCapture();

  bool Start();
  void Stop(std::string_view reason);
  bool running() const noexcept;

private:
  static constexpr std::size_t kBufferCount = 4;
  static constexpr std::size_t kBufferBytes = 3200;
  // Capture runs at 16 kHz mono, so 100 ms of audio; anything queued beyond
  // this was already dropped by the driver before we could send it.
  static constexpr std::size_t kMaxQueuedFrames = 16;

  static void CALLBACK WaveInCallback(
      HWAVEIN,
      UINT message,
      DWORD_PTR instance,
      DWORD_PTR parameter1,
      DWORD_PTR);
  void OnBuffer(WAVEHDR* header);
  void AudioSenderLoop();
  void CloseDevice();
  std::string StreamId() const;
  std::string TurnId() const;

  ag99::runtime::WinHttpWebSocketClient& websocket_;
  std::atomic<HWAVEIN> device_{nullptr};
  std::array<std::vector<std::uint8_t>, kBufferCount> buffers_{};
  std::array<WAVEHDR, kBufferCount> headers_{};
  std::array<bool, kBufferCount> prepared_{};
  std::atomic<bool> running_{false};
  // Guards the capture queue and the stream identity fields. Never held
  // across a waveIn or websocket call.
  mutable std::mutex queue_mutex_;
  std::condition_variable queue_condition_;
  std::deque<std::vector<std::uint8_t>> pending_frames_;
  std::uint64_t dropped_bytes_ = 0;
  // True between a successful stream start and its matching end, so Stop
  // still emits input.audio_stream_end after the sender already cleared
  // running_.
  bool running_stream_active_ = false;
  bool send_failed_ = false;
  std::string stream_id_;
  std::string turn_id_;
  std::uint64_t sequence_ = 0;
  std::atomic<std::uint64_t> next_stream_serial_{1};
  // Serialises Stop against CloseDevice, including the Stop -> CloseDevice
  // re-entry, so the waveIn teardown runs exactly once.
  std::recursive_mutex stop_mutex_;
  std::mutex join_mutex_;
  std::thread audio_worker_;
};

}  // namespace ag99::native