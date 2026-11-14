#pragma once

#include <string_view>
#include <mutex>

#include "ag99/native/microphone_capture.hpp"

namespace ag99::native {

// Owns capture lifecycle and device selection. Transport/session orchestration
// stays in NativeRuntimeCoordinator; capture itself is isolated here.
class NativeInputRuntime final {
public:
  explicit NativeInputRuntime(ag99::runtime::WinHttpWebSocketClient& websocket);
  ~NativeInputRuntime();

  NativeInputRuntime(const NativeInputRuntime&) = delete;
  NativeInputRuntime& operator=(const NativeInputRuntime&) = delete;

  bool ToggleMicrophone();
  bool StartMicrophone();
  bool Running() const noexcept;
  void Stop(std::string_view reason);
  ag99::runtime::DesktopSettingsResult HandleDeviceSetting(
      const ag99::runtime::DesktopSettingsQuery& query);

private:
  mutable std::mutex mutex_;
  MicrophoneCapture microphone_;
};

}  // namespace ag99::native
