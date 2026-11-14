#include <iostream>
#include <mutex>

#include "ag99/native/native_input_runtime.hpp"
#include "ag99/runtime/winhttp_websocket.hpp"

namespace ag99::native {

NativeInputRuntime::NativeInputRuntime(
    ag99::runtime::WinHttpWebSocketClient& websocket)
    : microphone_(websocket) {}

NativeInputRuntime::~NativeInputRuntime() {
  Stop("runtime_shutdown");
}

bool NativeInputRuntime::ToggleMicrophone() {
  std::scoped_lock lock(mutex_);
  if (microphone_.running()) {
    microphone_.Stop("manual_stop");
    return false;
  }
  if (!microphone_.Start()) {
    std::cerr << "[microphone] failed to start capture\n";
    return false;
  }
  return true;
}

bool NativeInputRuntime::StartMicrophone() {
  std::scoped_lock lock(mutex_);
  if (microphone_.running()) {
    return true;
  }
  if (!microphone_.Start()) {
    std::cerr << "[microphone] failed to start capture\n";
    return false;
  }
  return true;
}

bool NativeInputRuntime::Running() const noexcept {
  return microphone_.running();
}

void NativeInputRuntime::Stop(std::string_view reason) {
  std::scoped_lock lock(mutex_);
  microphone_.Stop(reason);
}

ag99::runtime::DesktopSettingsResult NativeInputRuntime::HandleDeviceSetting(
    const ag99::runtime::DesktopSettingsQuery& query) {
  std::scoped_lock lock(mutex_);
  return microphone_.HandleDeviceSetting(query);
}

}  // namespace ag99::native
