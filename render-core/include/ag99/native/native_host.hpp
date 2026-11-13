#pragma once

#include <windows.h>

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>

#include "ag99/platform/input_overlay_resources.hpp"
#include "ag99/platform/input_overlay_state.hpp"
#include "ag99/platform/tray_controller.hpp"

namespace ag99::native {

class NativeHost final {
public:
  struct Bindings {
    ag99::platform::TrayController* tray = nullptr;
    std::function<bool(std::string)>* send_text = nullptr;
    std::function<void()>* toggle_microphone = nullptr;
    std::function<bool()>* microphone_running = nullptr;
    std::function<bool()>* interrupt_turn = nullptr;
    std::function<bool()>* approve_latest_segment = nullptr;
    std::function<bool()>* reconnect_adapter = nullptr;
    bool* click_through = nullptr;
    bool* dragging = nullptr;
    POINT* drag_cursor = nullptr;
    POINT* drag_origin = nullptr;
    std::atomic<float>* drag_x = nullptr;
    std::atomic<float>* drag_y = nullptr;
    std::mutex* input_window_mutex = nullptr;
    HWND* input_window = nullptr;
    ag99::platform::InputOverlayState* input_state = nullptr;
    ag99::platform::InputOverlayResources* input_resources = nullptr;
    std::function<bool()> runtime_connected;
  };

  explicit NativeHost(Bindings bindings);
  ~NativeHost();

  NativeHost(const NativeHost&) = delete;
  NativeHost& operator=(const NativeHost&) = delete;

  HWND CreateMainWindow(
      HINSTANCE instance,
      UINT width,
      UINT height,
      const wchar_t* class_name,
      const wchar_t* title);
  void AddTrayIcon(HWND window);
  void RemoveTrayIcon();
  void ShowInputWindow(HINSTANCE instance);
  void NotifyInputConnectionChanged();
  void NotifyInputRuntimeStateChanged();

private:
  static NativeHost* FromWindow(HWND window);
  static LRESULT CALLBACK MainWindowProc(
      HWND window, UINT message, WPARAM wparam, LPARAM lparam);
  static LRESULT CALLBACK InputWindowProc(
      HWND window, UINT message, WPARAM wparam, LPARAM lparam);
  static LRESULT CALLBACK InputEditProc(
      HWND edit, UINT message, WPARAM wparam, LPARAM lparam);

  void ShowTrayMenu(HWND window);
  void SetClickThrough(HWND window, bool enabled);
  void SetInputStatus(HWND window, std::wstring_view text);
  void SetInputPreview(HWND window, std::wstring_view text);
  void SetInputConnectionLabels(HWND window);
  void SubmitInputText(HWND window);
  std::string LogPathForMessage() const;

  Bindings bindings_;
  HINSTANCE instance_ = nullptr;
  const wchar_t* class_name_ = nullptr;
  const wchar_t* title_ = nullptr;
};

}  // namespace ag99::native
