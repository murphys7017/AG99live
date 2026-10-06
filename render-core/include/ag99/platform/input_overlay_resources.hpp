#pragma once

#include <windows.h>

namespace ag99::platform {

struct InputOverlayResources {
  HBRUSH background_brush = nullptr;
  HBRUSH edit_brush = nullptr;
  HFONT message_font = nullptr;
  HFONT status_font = nullptr;
  HFONT input_font = nullptr;
};

InputOverlayResources CreateInputOverlayResources(
    HWND window,
    HFONT fallback_font);

void DestroyInputOverlayResources(InputOverlayResources& resources);

}  // namespace ag99::platform
