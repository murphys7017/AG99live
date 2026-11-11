#include <windows.h>
#include <imm.h>
#include <shellapi.h>
#include <windowsx.h>

#include <algorithm>
#include <string>
#include <utility>

#include "ag99/native/native_host.hpp"
#include "ag99/live2d/log.hpp"
#include "ag99/platform/input_overlay_button_paint.hpp"
#include "ag99/platform/input_overlay_controls.hpp"
#include "ag99/platform/input_overlay_paint.hpp"
#include "ag99/platform/input_overlay_view.hpp"
#include "ag99/platform/input_text.hpp"

namespace ag99::native {

constexpr UINT kTrayMessage = WM_APP + 1;
constexpr UINT kTrayShow = 1001;
constexpr UINT kTrayHide = 1002;
constexpr UINT kTrayExit = 1003;
constexpr UINT kTrayDemoText = 1004;
constexpr UINT kTrayMicToggle = 1005;
constexpr UINT kTrayInputWindow = 1006;
constexpr UINT kTrayClickThrough = 1007;
constexpr UINT kTrayOpenLog = 1008;
constexpr UINT kInputConnectionChanged = WM_APP + 2;
constexpr UINT kInputRuntimeStateChanged = WM_APP + 3;
constexpr wchar_t kInputClassName[] = L"AG99liveTextInputWindow";
constexpr UINT kInputSend = 2001;
constexpr UINT kInputMicToggle = 2003;
constexpr UINT kInputFeedback = 2004;
constexpr UINT kInputInterrupt = 2005;
constexpr int kInputControlId = 100;
constexpr int kInputMessageId = 101;
constexpr int kInputStatusId = 102;

NativeHost* NativeHost::active_ = nullptr;

NativeHost::NativeHost(Bindings bindings) : bindings_(std::move(bindings)) {
  active_ = this;
}

NativeHost::~NativeHost() {
  if (active_ == this) {
    active_ = nullptr;
  }
}
void NativeHost::AddTrayIcon(HWND window) {
  bindings_.tray->Add(window, kTrayMessage, L"AG99live Native Runtime");
}

void NativeHost::RemoveTrayIcon() {
  bindings_.tray->Remove();
}

std::string NativeHost::LogPathForMessage() const {
  const std::wstring& wide = ag99::live2d::LogFilePath();
  if (wide.empty()) {
    return "unavailable";
  }
  const int length = WideCharToMultiByte(
      CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()), nullptr, 0,
      nullptr, nullptr);
  if (length <= 0) {
    return "unavailable";
  }
  std::string result(static_cast<std::size_t>(length), '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()), result.data(),
      length, nullptr, nullptr);
  return result;
}

void NativeHost::ShowTrayMenu(HWND window) {
  POINT cursor{};
  GetCursorPos(&cursor);
  HMENU menu = CreatePopupMenu();
  if (!menu) {
    return;
  }
  const bool visible = IsWindowVisible(window) != FALSE;
  AppendMenuW(menu, MF_STRING, kTrayShow, L"显示模型");
  AppendMenuW(menu, MF_STRING, kTrayHide, L"隐藏模型");
  AppendMenuW(menu, MF_STRING, kTrayInputWindow, L"打开输入框");
  AppendMenuW(menu, MF_STRING, kTrayDemoText, L"发送演示文本");
  AppendMenuW(
      menu,
      MF_STRING,
      kTrayMicToggle,
      (*bindings_.microphone_running) && (*bindings_.microphone_running)()
          ? L"停止麦克风"
          : L"开始麦克风");
  AppendMenuW(
      menu, MF_STRING, kTrayClickThrough,
      *bindings_.click_through ? L"关闭点击穿透" : L"开启点击穿透");
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, kTrayOpenLog, L"打开日志目录");
  AppendMenuW(menu, MF_STRING, kTrayExit, L"退出 AG99live");
  EnableMenuItem(menu, kTrayShow, visible ? MF_GRAYED : MF_ENABLED);
  EnableMenuItem(menu, kTrayHide, visible ? MF_ENABLED : MF_GRAYED);
  SetForegroundWindow(window);
  TrackPopupMenu(
      menu, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, cursor.x, cursor.y, 0,
      window, nullptr);
  PostMessageW(window, WM_NULL, 0, 0);
  DestroyMenu(menu);
}

LRESULT CALLBACK NativeHost::MainWindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  auto* host = active_;
  if (!host) {
    return DefWindowProcW(window, message, wparam, lparam);
  }
  switch (message) {
    case WM_NCHITTEST:
      // WS_EX_TRANSPARENT changes paint ordering, not hit testing. Return
      // HTTRANSPARENT as well so the overlay does not consume mouse input
      // while click-through mode is enabled.
      if (*host->bindings_.click_through) {
        return HTTRANSPARENT;
      }
      return DefWindowProcW(window, message, wparam, lparam);
    case WM_ERASEBKGND:
      return 1;
    case WM_LBUTTONDOWN: {
      *host->bindings_.dragging = true;
      *host->bindings_.drag_cursor = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ClientToScreen(window, &*host->bindings_.drag_cursor);
      RECT rect{};
      GetWindowRect(window, &rect);
      *host->bindings_.drag_origin = {rect.left, rect.top};
      SetCapture(window);
      return 0;
    }
    case WM_MOUSEMOVE:
      if (*host->bindings_.dragging && (wparam & MK_LBUTTON) != 0) {
        RECT client_rect{};
        GetClientRect(window, &client_rect);
        const auto client_width = std::max<LONG>(1, client_rect.right);
        const auto client_height = std::max<LONG>(1, client_rect.bottom);
        const auto client_x = std::clamp<LONG>(
            GET_X_LPARAM(lparam), 0, client_width);
        const auto client_y = std::clamp<LONG>(
            GET_Y_LPARAM(lparam), 0, client_height);
        const auto drag_x = static_cast<float>(
            (static_cast<double>(client_x) / client_width) * 2.0 - 1.0);
        const auto drag_y = static_cast<float>(
            1.0 - (static_cast<double>(client_y) / client_height) * 2.0);
        host->bindings_.drag_x->store(std::clamp(drag_x, -1.0f, 1.0f));
        host->bindings_.drag_y->store(std::clamp(drag_y, -1.0f, 1.0f));
        POINT cursor{};
        GetCursorPos(&cursor);
        SetWindowPos(
            window, HWND_TOPMOST,
            host->bindings_.drag_origin->x + cursor.x - host->bindings_.drag_cursor->x,
            host->bindings_.drag_origin->y + cursor.y - host->bindings_.drag_cursor->y, 0, 0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
      }
      return 0;
    case WM_LBUTTONUP:
      if (*host->bindings_.dragging) {
        *host->bindings_.dragging = false;
        ReleaseCapture();
      }
      return 0;
    case WM_CLOSE:
      ShowWindow(window, SW_HIDE);
      return 0;
    case kTrayMessage:
      if (lparam == WM_RBUTTONUP || lparam == WM_LBUTTONUP ||
          lparam == WM_CONTEXTMENU) {
        host->ShowTrayMenu(window);
      }
      return 0;
    case WM_COMMAND:
      switch (LOWORD(wparam)) {
        case kTrayShow:
          ShowWindow(window, SW_SHOWNOACTIVATE);
          return 0;
        case kTrayHide:
          ShowWindow(window, SW_HIDE);
          return 0;
        case kTrayDemoText:
          if ((*host->bindings_.send_text)) {
            (*host->bindings_.send_text)("你好，这是原生 Live2D 核心演示。");
          }
          return 0;
        case kTrayInputWindow:
          host->ShowInputWindow(
              reinterpret_cast<HINSTANCE>(
                  GetWindowLongPtrW(window, GWLP_HINSTANCE)));
          return 0;
        case kTrayClickThrough:
          host->SetClickThrough(window, !*host->bindings_.click_through);
          return 0;
        case kTrayOpenLog: {
          const std::wstring& directory = ag99::live2d::LogDirectory();
          if (directory.empty()) {
            MessageBoxW(
                window, L"日志目录不可用。", host->title_, MB_OK | MB_ICONWARNING);
          } else {
            ShellExecuteW(
                nullptr, L"open", directory.c_str(), nullptr, nullptr,
                SW_SHOWNORMAL);
          }
          return 0;
        }
        case kTrayMicToggle:
          if ((*host->bindings_.toggle_microphone)) {
            (*host->bindings_.toggle_microphone)();
          }
          return 0;
        case kTrayExit:
          host->RemoveTrayIcon();
          DestroyWindow(window);
          return 0;
        default:
          break;
      }
      break;
    case WM_DESTROY:
      host->RemoveTrayIcon();
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

// --- Click-through -------------------------------------------------------
//
// WS_EX_TRANSPARENT makes the whole window forward its mouse input to the
// window underneath. It is the practical choice for a transparent Live2D
// overlay: nothing else can receive clicks while it is on, so it is a tray
// toggle rather than a permanent mode.

void NativeHost::SetClickThrough(HWND window, bool enabled) {
  if (!window) {
    return;
  }
  const LONG_PTR previous = GetWindowLongPtrW(window, GWL_EXSTYLE);
  LONG_PTR style = previous;
  if (enabled) {
    style |= WS_EX_TRANSPARENT;
  } else {
    style &= ~static_cast<LONG_PTR>(WS_EX_TRANSPARENT);
  }
  if (style != previous) {
    SetWindowLongPtrW(window, GWL_EXSTYLE, style);
  }
  // Extended styles only take effect after the window is re-applied.
  if (!SetWindowPos(
      window, HWND_TOPMOST, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED)) {
    if (style != previous) {
      SetWindowLongPtrW(window, GWL_EXSTYLE, previous);
    }
    AG99_ERROR("clickthrough", "failed to apply the window input style");
    return;
  }
  *bindings_.click_through = enabled;
  AG99_INFO(
      "clickthrough", enabled ? "enabled" : "disabled");
}

void NativeHost::SetInputStatus(HWND window, std::wstring_view text) {
  ag99::platform::SetInputOverlayStatus(window, kInputStatusId, text);
}

void NativeHost::SetInputPreview(HWND window, std::wstring_view text) {
  ag99::platform::SetInputOverlayPreview(window, kInputMessageId, text);
}

void NativeHost::SetInputConnectionLabels(HWND window) {
  if (!window) {
    return;
  }
  const ag99::platform::InputOverlayViewIds ids{
      kInputMessageId,
      kInputStatusId,
      kInputFeedback,
  };
  ag99::platform::ApplyInputOverlaySnapshot(
      window, bindings_.runtime_connected(), bindings_.input_state->Snapshot(), ids);
}

void NativeHost::SubmitInputText(HWND window) {
  const HWND edit = GetDlgItem(window, kInputControlId);
  if (!edit) {
    return;
  }
  const int length = GetWindowTextLengthW(edit);
  if (length <= 0) {
    SetInputStatus(window, L"请输入文本");
    return;
  }
  std::wstring buffer(static_cast<std::size_t>(length) + 1, L'\0');
  const int copied = GetWindowTextW(
      edit, buffer.data(), static_cast<int>(buffer.size()));
  buffer.resize(copied > 0 ? static_cast<std::size_t>(copied) : 0);
  buffer = ag99::platform::TrimInputText(std::move(buffer));
  const std::string text = ag99::platform::InputTextToUtf8(buffer);
  if (text.empty()) {
    SetInputStatus(window, L"请输入文本");
    return;
  }
  if (!(*bindings_.send_text) || !(*bindings_.send_text)(text)) {
    SetInputStatus(window, L"发送失败：未连接到 Adapter");
    AG99_ERROR("input", "send failed for user text");
    return;
  }
  AG99_INFO("input", std::string("sent user text, ")
      + std::to_string(text.size()) + " bytes");
  SetWindowTextW(edit, L"");
  SetInputStatus(window, L"已发送");
}

LRESULT CALLBACK NativeHost::InputEditProc(
    HWND edit, UINT message, WPARAM wparam, LPARAM lparam) {
  auto* active = active_;
  if (!active) {
    return DefWindowProcW(edit, message, wparam, lparam);
  }
  if (message == WM_KEYDOWN && wparam == VK_RETURN) {
    HIMC context = ImmGetContext(edit);
    const bool composing = context != nullptr
        && ImmGetCompositionStringW(context, GCS_COMPSTR, nullptr, 0) > 0;
    if (context) {
      ImmReleaseContext(edit, context);
    }
    if (composing) {
      const auto previous = reinterpret_cast<WNDPROC>(
          GetPropW(edit, L"AG99liveInputPreviousProc"));
      return previous
          ? CallWindowProcW(previous, edit, message, wparam, lparam)
          : DefWindowProcW(edit, message, wparam, lparam);
    }
    if (const HWND parent = GetParent(edit)) {
      active_->SubmitInputText(parent);
    }
    return 0;
  }

  const auto previous = reinterpret_cast<WNDPROC>(
      GetPropW(edit, L"AG99liveInputPreviousProc"));
  if (previous) {
    return CallWindowProcW(previous, edit, message, wparam, lparam);
  }
  return DefWindowProcW(edit, message, wparam, lparam);
}

LRESULT CALLBACK NativeHost::InputWindowProc(
    HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  auto* host = active_;
  if (!host) {
    return DefWindowProcW(window, message, wparam, lparam);
  }
  switch (message) {
    case WM_COMMAND:
      if (LOWORD(wparam) == kInputSend) {
        host->SubmitInputText(window);
        return 0;
      }
      if (LOWORD(wparam) == kInputMicToggle) {
        if ((*host->bindings_.toggle_microphone)) {
          (*host->bindings_.toggle_microphone)();
          host->SetInputStatus(
              window,
              (*host->bindings_.microphone_running) && (*host->bindings_.microphone_running)()
                  ? L"麦克风已开启" : L"麦克风已关闭");
        } else {
          host->SetInputStatus(window, L"麦克风不可用");
        }
        return 0;
      }
      if (LOWORD(wparam) == kInputFeedback) {
        const bool sent = (*host->bindings_.approve_latest_segment) && (*host->bindings_.approve_latest_segment)();
        host->SetInputStatus(window, sent ? L"已赞同最近一条回复" : L"暂无可赞同的回复");
        return 0;
      }
      if (LOWORD(wparam) == kInputInterrupt) {
        const bool sent = (*host->bindings_.interrupt_turn) && (*host->bindings_.interrupt_turn)();
        host->SetInputStatus(window, sent ? L"已打断当前回复" : L"当前没有可打断的回复");
        return 0;
      }
      break;
    case WM_NCHITTEST: {
      POINT point{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
      ScreenToClient(window, &point);
      RECT drag_zone{0, 0, 420, 84};
      return PtInRect(&drag_zone, point) ? HTCAPTION : HTCLIENT;
    }
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT: {
      PAINTSTRUCT paint{};
      const HDC dc = BeginPaint(window, &paint);
      RECT client{};
      GetClientRect(window, &client);
      if (!host->bindings_.input_resources->background_brush) {
        host->bindings_.input_resources->background_brush = CreateSolidBrush(RGB(8, 9, 12));
      }
      ag99::platform::PaintInputOverlayBackground(
          dc, client, host->bindings_.input_resources->background_brush);
      EndPaint(window, &paint);
      return 0;
    }
    case WM_CTLCOLORSTATIC: {
      const HDC dc = reinterpret_cast<HDC>(wparam);
      SetTextColor(dc, RGB(232, 234, 240));
      SetBkMode(dc, TRANSPARENT);
      return reinterpret_cast<LRESULT>(host->bindings_.input_resources->background_brush);
    }
    case WM_CTLCOLOREDIT: {
      const HDC dc = reinterpret_cast<HDC>(wparam);
      SetTextColor(dc, RGB(238, 240, 246));
      SetBkColor(dc, RGB(19, 21, 26));
      if (!host->bindings_.input_resources->edit_brush) {
        host->bindings_.input_resources->edit_brush = CreateSolidBrush(RGB(19, 21, 26));
      }
      return reinterpret_cast<LRESULT>(host->bindings_.input_resources->edit_brush);
    }
    case WM_NCPAINT: {
      // The TS composer uses a soft 1px border rather than the native
      // client-edge frame. Paint the control border ourselves.
      const HWND edit = GetDlgItem(window, kInputControlId);
      ag99::platform::PaintInputOverlayEditBorder(edit);
      return 0;
    }
    case WM_DRAWITEM: {
      if (ag99::platform::PaintInputOverlayButton(
          reinterpret_cast<const DRAWITEMSTRUCT*>(lparam),
          kInputSend,
          kInputMicToggle,
          kInputFeedback,
          kInputInterrupt)) {
        return TRUE;
      }
      break;
    }
    case kInputConnectionChanged:
    case kInputRuntimeStateChanged:
      host->SetInputConnectionLabels(window);
      return 0;
    case WM_DESTROY:
      {
        std::scoped_lock lock(*host->bindings_.input_window_mutex);
        *host->bindings_.input_window = nullptr;
      }
      ag99::platform::DestroyInputOverlayResources(*host->bindings_.input_resources);
      return 0;
    default:
      break;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}

void NativeHost::ShowInputWindow(HINSTANCE instance) {
  HWND existing = nullptr;
  {
    std::scoped_lock lock(*bindings_.input_window_mutex);
    existing = *bindings_.input_window;
  }
  if (existing) {
    SetForegroundWindow(existing);
    SetWindowPos(
        existing, HWND_TOPMOST, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    return;
  }

  WNDCLASSEXW window_class{};
  window_class.cbSize = sizeof(window_class);
  window_class.lpfnWndProc = &NativeHost::InputWindowProc;
  window_class.hInstance = instance;
  window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  window_class.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_BTNFACE + 1);
  window_class.lpszClassName = kInputClassName;
  RegisterClassExW(&window_class);

  const int width = 420;
  const int height = 168;
  const int x = GetSystemMetrics(SM_CXSCREEN) - width - 28;
  const int y = GetSystemMetrics(SM_CYSCREEN) - height - 96;
  HWND window = CreateWindowExW(
      WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_LAYERED,
      kInputClassName,
      L"AG99live",
      WS_POPUP,
      x, y, width, height, nullptr, nullptr, instance, nullptr);
  if (!window) {
    AG99_ERROR("input", "failed to create the input window");
    return;
  }
  {
    std::scoped_lock lock(*bindings_.input_window_mutex);
    *bindings_.input_window = window;
  }
  SetLayeredWindowAttributes(window, 0, 255, LWA_ALPHA);
  SetWindowRgn(window, CreateRoundRectRgn(0, 0, width + 1, height + 1, 12, 12), TRUE);
  const HFONT font = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
  *bindings_.input_resources = ag99::platform::CreateInputOverlayResources(window, font);

  const ag99::platform::InputOverlayControlIds control_ids{
      kInputControlId,
      kInputMessageId,
      kInputStatusId,
      static_cast<int>(kInputMicToggle),
      static_cast<int>(kInputFeedback),
      static_cast<int>(kInputInterrupt),
      static_cast<int>(kInputSend),
  };
  const ag99::platform::InputOverlayControlFonts control_fonts{
      font,
      bindings_.input_resources->message_font,
      bindings_.input_resources->status_font,
      bindings_.input_resources->input_font,
  };
  const auto controls = ag99::platform::CreateInputOverlayControls(
      window,
      instance,
      control_ids,
      control_fonts,
      &InputEditProc);

  ShowWindow(window, SW_SHOW);
  UpdateWindow(window);
  SetInputConnectionLabels(window);
  if (controls.input) {
    SetFocus(controls.input);
  }
  AG99_INFO("input", "text input window opened");
}


HWND NativeHost::CreateMainWindow(
    HINSTANCE instance,
    UINT width,
    UINT height,
    const wchar_t* class_name,
    const wchar_t* title) {
  instance_ = instance;
  class_name_ = class_name;
  title_ = title;
  active_ = this;
  WNDCLASSEXW window_class{
      sizeof(WNDCLASSEXW),
      CS_HREDRAW | CS_VREDRAW,
      &NativeHost::MainWindowProc,
      0,
      0,
      instance,
      nullptr,
      LoadCursorW(nullptr, IDC_ARROW),
      nullptr,
      nullptr,
      class_name,
      nullptr};
  if (!RegisterClassExW(&window_class)) {
    return nullptr;
  }
  HWND window = CreateWindowExW(
      WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_NOREDIRECTIONBITMAP
          | WS_EX_LAYERED,
      class_name,
      title,
      WS_POPUP,
      CW_USEDEFAULT,
      CW_USEDEFAULT,
      static_cast<int>(width),
      static_cast<int>(height),
      nullptr,
      nullptr,
      instance,
      nullptr);
  if (!window) {
    return nullptr;
  }
  if (!SetLayeredWindowAttributes(window, 0, 255, LWA_ALPHA)) {
    DestroyWindow(window);
    return nullptr;
  }
  const int x = (GetSystemMetrics(SM_CXSCREEN) - static_cast<int>(width)) / 2;
  const int y = (GetSystemMetrics(SM_CYSCREEN) - static_cast<int>(height)) / 2;
  SetWindowPos(
      window, HWND_TOPMOST, x, y, static_cast<int>(width),
      static_cast<int>(height), SWP_NOACTIVATE);
  return window;
}

void NativeHost::NotifyInputConnectionChanged() {
  std::scoped_lock lock(*bindings_.input_window_mutex);
  if (*bindings_.input_window) {
    PostMessageW(*bindings_.input_window, kInputConnectionChanged, 0, 0);
  }
}

void NativeHost::NotifyInputRuntimeStateChanged() {
  std::scoped_lock lock(*bindings_.input_window_mutex);
  if (*bindings_.input_window) {
    PostMessageW(*bindings_.input_window, kInputRuntimeStateChanged, 0, 0);
  }
}
}  // namespace ag99::native
