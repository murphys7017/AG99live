#include "ag99/platform/input_overlay_view.hpp"

#include <string>

namespace ag99::platform {

void SetInputOverlayStatus(
    HWND window,
    int status_control_id,
    std::wstring_view text) {
  if (const HWND status = GetDlgItem(window, status_control_id)) {
    SetWindowTextW(status, std::wstring(text).c_str());
  }
}

void SetInputOverlayPreview(
    HWND window,
    int preview_control_id,
    std::wstring_view text) {
  if (const HWND preview = GetDlgItem(window, preview_control_id)) {
    SetWindowTextW(preview, std::wstring(text).c_str());
  }
}

void ApplyInputOverlaySnapshot(
    HWND window,
    bool connected,
    const InputOverlaySnapshot& snapshot,
    const InputOverlayViewIds& ids) {
  if (!window) {
    return;
  }

  SetInputOverlayPreview(
      window,
      ids.preview,
      connected ? std::wstring_view(snapshot.preview_text)
                : std::wstring_view(L"连接已关闭。"));
  SetInputOverlayStatus(
      window,
      ids.status,
      connected ? std::wstring_view(snapshot.status_text)
                : std::wstring_view(L"离线"));
  if (const HWND feedback = GetDlgItem(window, ids.feedback)) {
    EnableWindow(
        feedback,
        connected && snapshot.feedback_available
            && !snapshot.feedback_approved);
    InvalidateRect(feedback, nullptr, TRUE);
  }
}

}  // namespace ag99::platform
