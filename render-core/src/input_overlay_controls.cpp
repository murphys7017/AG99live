#include "ag99/platform/input_overlay_controls.hpp"

#ifndef EM_SETCUEBANNER
#define EM_SETCUEBANNER (WM_USER + 1)
#endif

namespace ag99::platform {

namespace {

HMENU ControlMenu(int id) {
  return reinterpret_cast<HMENU>(static_cast<UINT_PTR>(id));
}

void ApplyFont(HWND control, HFONT font) {
  if (control) {
    SendMessageW(
        control, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
  }
}

}  // namespace

InputOverlayControls CreateInputOverlayControls(
    HWND parent,
    HINSTANCE instance,
    const InputOverlayControlIds& ids,
    const InputOverlayControlFonts& fonts,
    WNDPROC input_window_proc) {
  const HWND message = CreateWindowExW(
      0, L"STATIC", L"连接已关闭。", WS_CHILD | WS_VISIBLE,
      12, 16, 396, 52, parent, ControlMenu(ids.message), instance, nullptr);
  ApplyFont(message, fonts.message ? fonts.message : fonts.fallback);

  const HWND status = CreateWindowExW(
      0, L"STATIC", L"离线", WS_CHILD | WS_VISIBLE,
      12, 78, 260, 20, parent, ControlMenu(ids.status), instance, nullptr);
  ApplyFont(status, fonts.status ? fonts.status : fonts.fallback);

  const HWND microphone = CreateWindowExW(
      0, L"BUTTON", L"麦", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
      330, 72, 26, 26, parent, ControlMenu(ids.microphone), instance,
      nullptr);
  ApplyFont(microphone, fonts.fallback);

  const HWND feedback = CreateWindowExW(
      0, L"BUTTON", L"赞", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
      360, 72, 26, 26, parent, ControlMenu(ids.feedback), instance, nullptr);
  ApplyFont(feedback, fonts.fallback);

  const HWND interrupt = CreateWindowExW(
      0, L"BUTTON", L"■", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
      390, 72, 26, 26, parent, ControlMenu(ids.interrupt), instance, nullptr);
  ApplyFont(interrupt, fonts.fallback);

  const HWND input = CreateWindowExW(
      WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP |
      ES_AUTOHSCROLL,
      10, 108, 366, 32, parent, ControlMenu(ids.input), instance, nullptr);
  if (input) {
    ApplyFont(input, fonts.input ? fonts.input : fonts.fallback);
    SendMessageW(input, EM_SETLIMITTEXT, 2000, 0);
    SendMessageW(input, EM_SETCUEBANNER, TRUE,
        reinterpret_cast<LPARAM>(L"直接和桌宠说话"));
    const auto previous = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(
        input, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(input_window_proc)));
    if (previous) {
      SetPropW(
          input, L"AG99liveInputPreviousProc",
          reinterpret_cast<HANDLE>(previous));
    }
  }

  const HWND send = CreateWindowExW(
      0, L"BUTTON", L"➤", WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW,
      384, 108, 26, 32, parent, ControlMenu(ids.send), instance, nullptr);
  ApplyFont(send, fonts.fallback);

  return {message, status, microphone, feedback, interrupt, input, send};
}

}  // namespace ag99::platform
