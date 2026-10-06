#pragma once

#include <windows.h>

#include <string_view>

#include "ag99/platform/input_overlay_state.hpp"

namespace ag99::platform {

struct InputOverlayViewIds {
  int preview;
  int status;
  int feedback;
};

void SetInputOverlayStatus(
    HWND window,
    int status_control_id,
    std::wstring_view text);

void SetInputOverlayPreview(
    HWND window,
    int preview_control_id,
    std::wstring_view text);

void ApplyInputOverlaySnapshot(
    HWND window,
    bool connected,
    const InputOverlaySnapshot& snapshot,
    const InputOverlayViewIds& ids);

}  // namespace ag99::platform
