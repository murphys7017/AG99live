#include "ag99/platform/input_overlay_paint.hpp"

namespace ag99::platform {

void PaintInputOverlayBackground(
    HDC device_context,
    const RECT& client_rect,
    HBRUSH background_brush) {
  FillRect(device_context, &client_rect, background_brush);
  HPEN border = CreatePen(PS_SOLID, 1, RGB(52, 54, 62));
  HGDIOBJ previous_pen = SelectObject(device_context, border);
  HGDIOBJ previous_brush = SelectObject(
      device_context, GetStockObject(NULL_BRUSH));
  RoundRect(
      device_context,
      0,
      0,
      client_rect.right,
      client_rect.bottom,
      12,
      12);
  SelectObject(device_context, previous_brush);
  SelectObject(device_context, previous_pen);
  DeleteObject(border);
}

void PaintInputOverlayEditBorder(HWND edit_control) {
  if (!edit_control) {
    return;
  }
  HDC device_context = GetWindowDC(edit_control);
  if (!device_context) {
    return;
  }
  RECT rect{};
  GetWindowRect(edit_control, &rect);
  OffsetRect(&rect, -rect.left, -rect.top);
  HPEN pen = CreatePen(PS_SOLID, 1, RGB(52, 54, 62));
  HGDIOBJ previous_pen = SelectObject(device_context, pen);
  HGDIOBJ previous_brush = SelectObject(
      device_context, GetStockObject(NULL_BRUSH));
  RoundRect(
      device_context,
      0,
      0,
      rect.right,
      rect.bottom,
      8,
      8);
  SelectObject(device_context, previous_brush);
  SelectObject(device_context, previous_pen);
  DeleteObject(pen);
  ReleaseDC(edit_control, device_context);
}

}  // namespace ag99::platform
