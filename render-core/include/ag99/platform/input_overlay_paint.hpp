#pragma once

#include <windows.h>

namespace ag99::platform {

void PaintInputOverlayBackground(
    HDC device_context,
    const RECT& client_rect,
    HBRUSH background_brush);

void PaintInputOverlayEditBorder(HWND edit_control);

}  // namespace ag99::platform
