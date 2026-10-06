#pragma once

#include <mutex>
#include <string>

namespace ag99::platform {

struct InputOverlaySnapshot final {
  std::wstring preview_text;
  std::wstring status_text;
  bool feedback_available = false;
  bool feedback_approved = false;
};

class InputOverlayState final {
public:
  InputOverlayState() = default;

  void SetPreviewText(std::wstring text);
  void SetStatusText(std::wstring text);
  void SetFeedbackAvailable(bool available);
  void SetFeedbackApproved(bool approved);
  void ResetDisconnected();

  InputOverlaySnapshot Snapshot() const;

private:
  mutable std::mutex mutex_;
  std::wstring preview_text_ = L"连接已关闭。";
  std::wstring status_text_ = L"离线";
  bool feedback_available_ = false;
  bool feedback_approved_ = false;
};

}  // namespace ag99::platform
