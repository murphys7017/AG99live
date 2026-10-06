#include "ag99/platform/tray_controller.hpp"

#include <shellapi.h>

#include <iterator>

namespace ag99::platform {

TrayController::~TrayController() {
  Remove();
}

bool TrayController::Add(HWND window, UINT callback_message, LPCWSTR tooltip) {
  Remove();
  icon_ = {};
  icon_.cbSize = sizeof(icon_);
  icon_.hWnd = window;
  icon_.uID = 1;
  icon_.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  icon_.uCallbackMessage = callback_message;
  icon_.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  if (tooltip) {
    wcsncpy_s(icon_.szTip, std::size(icon_.szTip), tooltip, _TRUNCATE);
  }
  added_ = Shell_NotifyIconW(NIM_ADD, &icon_) != FALSE;
  return added_;
}

void TrayController::Remove() {
  if (!added_) {
    return;
  }
  Shell_NotifyIconW(NIM_DELETE, &icon_);
  added_ = false;
}

}  // namespace ag99::platform
