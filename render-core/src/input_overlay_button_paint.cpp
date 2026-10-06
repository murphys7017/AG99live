#include "ag99/platform/input_overlay_button_paint.hpp"

#include <iterator>

namespace ag99::platform {

bool PaintInputOverlayButton(
    const DRAWITEMSTRUCT* item,
    UINT send_control_id,
    UINT microphone_control_id,
    UINT feedback_control_id,
    UINT interrupt_control_id) {
  if (!item || (item->CtlID != send_control_id
                && item->CtlID != microphone_control_id
                && item->CtlID != feedback_control_id
                && item->CtlID != interrupt_control_id)) {
    return false;
  }

  const bool pressed = (item->itemState & ODS_SELECTED) != 0;
  const bool disabled = (item->itemState & ODS_DISABLED) != 0;
  const COLORREF fill = disabled ? RGB(20, 22, 27)
      : (pressed ? RGB(45, 51, 64) : RGB(34, 37, 46));
  HBRUSH button_brush = CreateSolidBrush(fill);
  HPEN button_pen = CreatePen(PS_SOLID, 1, RGB(76, 82, 96));
  HGDIOBJ previous_brush = SelectObject(item->hDC, button_brush);
  HGDIOBJ previous_pen = SelectObject(item->hDC, button_pen);
  RoundRect(
      item->hDC,
      item->rcItem.left,
      item->rcItem.top,
      item->rcItem.right,
      item->rcItem.bottom,
      10,
      10);
  SelectObject(item->hDC, previous_pen);
  SelectObject(item->hDC, previous_brush);
  DeleteObject(button_pen);
  DeleteObject(button_brush);

  const int center_x = (item->rcItem.left + item->rcItem.right) / 2;
  const int center_y = (item->rcItem.top + item->rcItem.bottom) / 2;
  HPEN icon_pen = CreatePen(PS_SOLID, 1,
      disabled ? RGB(105, 108, 118) : RGB(232, 235, 242));
  HGDIOBJ previous_icon_pen = SelectObject(item->hDC, icon_pen);
  HGDIOBJ previous_icon_brush = SelectObject(
      item->hDC, GetStockObject(NULL_BRUSH));
  if (item->CtlID == microphone_control_id) {
    RoundRect(item->hDC, center_x - 4, center_y - 9,
              center_x + 4, center_y + 3, 5, 5);
    Arc(item->hDC, center_x - 10, center_y - 2,
        center_x + 10, center_y + 10, center_x + 10, center_y + 4,
        center_x - 10, center_y + 4);
    MoveToEx(item->hDC, center_x, center_y + 10, nullptr);
    LineTo(item->hDC, center_x, center_y + 5);
    MoveToEx(item->hDC, center_x - 4, center_y + 10, nullptr);
    LineTo(item->hDC, center_x + 4, center_y + 10);
  } else if (item->CtlID == feedback_control_id) {
    MoveToEx(item->hDC, center_x - 8, center_y - 2, nullptr);
    LineTo(item->hDC, center_x - 3, center_y - 2);
    LineTo(item->hDC, center_x + 1, center_y - 9);
    LineTo(item->hDC, center_x + 4, center_y - 8);
    LineTo(item->hDC, center_x + 2, center_y - 2);
    LineTo(item->hDC, center_x + 8, center_y - 2);
    LineTo(item->hDC, center_x + 8, center_y + 7);
    LineTo(item->hDC, center_x - 3, center_y + 7);
    LineTo(item->hDC, center_x - 8, center_y + 7);
    LineTo(item->hDC, center_x - 8, center_y - 2);
  } else if (item->CtlID == interrupt_control_id) {
    Rectangle(item->hDC, center_x - 5, center_y - 5,
              center_x + 5, center_y + 5);
  } else if (item->CtlID == send_control_id) {
    POINT plane[] = {
        {center_x - 8, center_y - 1},
        {center_x + 8, center_y - 8},
        {center_x + 2, center_y + 8},
        {center_x - 1, center_y + 2},
        {center_x - 8, center_y - 1},
    };
    Polyline(item->hDC, plane, static_cast<int>(std::size(plane)));
    MoveToEx(item->hDC, center_x - 1, center_y + 2, nullptr);
    LineTo(item->hDC, center_x + 8, center_y - 8);
  } else {
    wchar_t text[64]{};
    GetWindowTextW(item->hwndItem, text, static_cast<int>(std::size(text)));
    SetBkMode(item->hDC, TRANSPARENT);
    SetTextColor(item->hDC, RGB(232, 235, 242));
    RECT text_rect = item->rcItem;
    DrawTextW(item->hDC, text, -1, &text_rect,
        DT_CENTER | DT_VCENTER | DT_SINGLELINE);
  }
  SelectObject(item->hDC, previous_icon_brush);
  SelectObject(item->hDC, previous_icon_pen);
  DeleteObject(icon_pen);
  return true;
}

}  // namespace ag99::platform
