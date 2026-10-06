#include "ag99/platform/input_overlay_state.hpp"

#include <utility>

namespace ag99::platform {

void InputOverlayState::SetPreviewText(std::wstring text) {
  std::scoped_lock lock(mutex_);
  preview_text_ = std::move(text);
}

void InputOverlayState::SetStatusText(std::wstring text) {
  std::scoped_lock lock(mutex_);
  status_text_ = std::move(text);
}

void InputOverlayState::SetFeedbackAvailable(bool available) {
  std::scoped_lock lock(mutex_);
  feedback_available_ = available;
}

void InputOverlayState::SetFeedbackApproved(bool approved) {
  std::scoped_lock lock(mutex_);
  feedback_approved_ = approved;
}

void InputOverlayState::ResetDisconnected() {
  std::scoped_lock lock(mutex_);
  preview_text_ = L"连接已关闭。";
  status_text_ = L"离线";
  feedback_available_ = false;
  feedback_approved_ = false;
}

InputOverlaySnapshot InputOverlayState::Snapshot() const {
  std::scoped_lock lock(mutex_);
  return InputOverlaySnapshot{
      preview_text_,
      status_text_,
      feedback_available_,
      feedback_approved_};
}

}  // namespace ag99::platform
