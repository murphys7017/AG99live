import type { DesktopPttKeyBinding } from "../../types/desktop.js";

export const DEFAULT_PTT_KEY_BINDING: DesktopPttKeyBinding = {
  code: "ControlLeft",
  label: "Left Ctrl",
  uiohookKeycode: 29,
};

const DOM_CODE_TO_UIOHOOK_KEYCODE: Record<string, number> = {
  Backspace: 14,
  Tab: 15,
  Enter: 28,
  CapsLock: 58,
  Escape: 1,
  Space: 57,
  PageUp: 3657,
  PageDown: 3665,
  End: 3663,
  Home: 3655,
  ArrowLeft: 57419,
  ArrowUp: 57416,
  ArrowRight: 57421,
  ArrowDown: 57424,
  Insert: 3666,
  Delete: 3667,
  Digit0: 11,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5,
  Digit5: 6,
  Digit6: 7,
  Digit7: 8,
  Digit8: 9,
  Digit9: 10,
  KeyA: 30,
  KeyB: 48,
  KeyC: 46,
  KeyD: 32,
  KeyE: 18,
  KeyF: 33,
  KeyG: 34,
  KeyH: 35,
  KeyI: 23,
  KeyJ: 36,
  KeyK: 37,
  KeyL: 38,
  KeyM: 50,
  KeyN: 49,
  KeyO: 24,
  KeyP: 25,
  KeyQ: 16,
  KeyR: 19,
  KeyS: 31,
  KeyT: 20,
  KeyU: 22,
  KeyV: 47,
  KeyW: 17,
  KeyX: 45,
  KeyY: 21,
  KeyZ: 44,
  Numpad0: 82,
  Numpad1: 79,
  Numpad2: 80,
  Numpad3: 81,
  Numpad4: 75,
  Numpad5: 76,
  Numpad6: 77,
  Numpad7: 71,
  Numpad8: 72,
  Numpad9: 73,
  NumpadMultiply: 55,
  NumpadAdd: 78,
  NumpadSubtract: 74,
  NumpadDecimal: 83,
  NumpadDivide: 3637,
  NumpadEnter: 3612,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  F11: 87,
  F12: 88,
  Semicolon: 39,
  Equal: 13,
  Comma: 51,
  Minus: 12,
  Period: 52,
  Slash: 53,
  Backquote: 41,
  BracketLeft: 26,
  Backslash: 43,
  BracketRight: 27,
  Quote: 40,
  ControlLeft: 29,
  ControlRight: 3613,
  AltLeft: 56,
  AltRight: 3640,
  ShiftLeft: 42,
  ShiftRight: 54,
  MetaLeft: 3675,
  MetaRight: 3676,
  NumLock: 69,
  ScrollLock: 70,
  PrintScreen: 3639,
};

const DOM_CODE_LABELS: Record<string, string> = {
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  MetaLeft: "Left Meta",
  MetaRight: "Right Meta",
  Space: "Space",
  Escape: "Esc",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

export function normalizePttKeyBinding(value: unknown): DesktopPttKeyBinding {
  if (!value || typeof value !== "object") {
    return DEFAULT_PTT_KEY_BINDING;
  }

  const raw = value as {
    code?: unknown;
    label?: unknown;
    uiohookKeycode?: unknown;
  };
  const code = typeof raw.code === "string" ? raw.code.trim() : "";
  if (!code) {
    return DEFAULT_PTT_KEY_BINDING;
  }

  return {
    code,
    label: normalizePttKeyLabel(code, raw.label),
    uiohookKeycode: normalizeUiohookKeycode(code, raw.uiohookKeycode),
  };
}

export function createPttKeyBindingFromKeyboardEvent(
  event: KeyboardEvent,
): DesktopPttKeyBinding {
  const code = event.code.trim();
  return normalizePttKeyBinding({
    code,
    label: formatKeyboardEventLabel(event),
    uiohookKeycode: DOM_CODE_TO_UIOHOOK_KEYCODE[code] ?? null,
  });
}

export function matchesPttKeyBinding(
  event: KeyboardEvent,
  binding: DesktopPttKeyBinding,
): boolean {
  return event.code === binding.code;
}

function normalizeUiohookKeycode(code: string, value: unknown): number | null {
  const mapped = DOM_CODE_TO_UIOHOOK_KEYCODE[code];
  if (typeof mapped === "number") {
    return mapped;
  }

  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function normalizePttKeyLabel(code: string, value: unknown): string {
  const rawLabel = typeof value === "string" ? value.trim() : "";
  if (rawLabel) {
    return rawLabel;
  }

  const known = DOM_CODE_LABELS[code];
  if (known) {
    return known;
  }

  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return `Numpad ${code.slice(6)}`;
  }

  return code;
}

function formatKeyboardEventLabel(event: KeyboardEvent): string {
  const known = DOM_CODE_LABELS[event.code];
  if (known) {
    return known;
  }

  if (/^Key[A-Z]$/.test(event.code)) {
    return event.code.slice(3);
  }
  if (/^Digit[0-9]$/.test(event.code)) {
    return event.code.slice(5);
  }

  const key = event.key.trim();
  if (key && key !== "Unidentified") {
    return key.length === 1 ? key.toUpperCase() : key;
  }

  return event.code;
}
