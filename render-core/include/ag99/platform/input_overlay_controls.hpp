#pragma once

#include <windows.h>

namespace ag99::platform {

struct InputOverlayControlIds {
  int input;
  int message;
  int status;
  int microphone;
  int feedback;
  int interrupt;
  int send;
};

struct InputOverlayControlFonts {
  HFONT fallback;
  HFONT message;
  HFONT status;
  HFONT input;
};

struct InputOverlayControls {
  HWND message;
  HWND status;
  HWND microphone;
  HWND feedback;
  HWND interrupt;
  HWND input;
  HWND send;
};

InputOverlayControls CreateInputOverlayControls(
    HWND parent,
    HINSTANCE instance,
    const InputOverlayControlIds& ids,
    const InputOverlayControlFonts& fonts,
    WNDPROC input_window_proc);

}  // namespace ag99::platform
