#pragma once

#include <windows.h>
#include <shellapi.h>

namespace ag99::platform {

class TrayController final {
public:
  TrayController() = default;
  ~TrayController();

  TrayController(const TrayController&) = delete;
  TrayController& operator=(const TrayController&) = delete;

  bool Add(HWND window, UINT callback_message, LPCWSTR tooltip);
  void Remove();
  bool added() const noexcept { return added_; }

private:
  NOTIFYICONDATAW icon_{};
  bool added_ = false;
};

}  // namespace ag99::platform
