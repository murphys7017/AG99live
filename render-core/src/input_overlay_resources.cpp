#include "ag99/platform/input_overlay_resources.hpp"

namespace ag99::platform {

InputOverlayResources CreateInputOverlayResources(
    HWND window,
    HFONT fallback_font) {
  InputOverlayResources resources{
      CreateSolidBrush(RGB(8, 9, 12)),
      CreateSolidBrush(RGB(19, 21, 26)),
      nullptr,
      nullptr,
      nullptr,
  };

  LOGFONTW message_logfont{};
  GetObjectW(fallback_font, sizeof(message_logfont), &message_logfont);
  HDC window_dc = GetDC(window);
  const int dpi = window_dc ? GetDeviceCaps(window_dc, LOGPIXELSY) : 96;
  if (window_dc) {
    ReleaseDC(window, window_dc);
  }
  message_logfont.lfHeight = -MulDiv(14, dpi, 72);
  message_logfont.lfWeight = FW_NORMAL;
  resources.message_font = CreateFontIndirectW(&message_logfont);
  message_logfont.lfHeight = -MulDiv(12, dpi, 72);
  resources.status_font = CreateFontIndirectW(&message_logfont);
  message_logfont.lfHeight = -MulDiv(14, dpi, 72);
  resources.input_font = CreateFontIndirectW(&message_logfont);
  return resources;
}

void DestroyInputOverlayResources(InputOverlayResources& resources) {
  if (resources.background_brush) {
    DeleteObject(resources.background_brush);
    resources.background_brush = nullptr;
  }
  if (resources.edit_brush) {
    DeleteObject(resources.edit_brush);
    resources.edit_brush = nullptr;
  }
  if (resources.message_font) {
    DeleteObject(resources.message_font);
    resources.message_font = nullptr;
  }
  if (resources.status_font) {
    DeleteObject(resources.status_font);
    resources.status_font = nullptr;
  }
  if (resources.input_font) {
    DeleteObject(resources.input_font);
    resources.input_font = nullptr;
  }
}

}  // namespace ag99::platform
