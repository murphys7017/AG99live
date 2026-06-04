import { DEFAULT_ADAPTER_ADDRESS } from "./address.js";
import {
  DEFAULT_PTT_KEY_BINDING,
  normalizePttKeyBinding,
} from "./pttKeyBinding.js";
import type { DesktopPttKeyBinding } from "../../types/desktop.js";

const ADDRESS_STORAGE_KEY = "ag99live.adapter.address";
const DESKTOP_SCREENSHOT_ON_SEND_STORAGE_KEY = "ag99live.desktop.capture_on_send";
const MICROPHONE_DEVICE_ID_STORAGE_KEY = "ag99live.microphone.device_id";
const PTT_KEY_BINDING_STORAGE_KEY = "ag99live.microphone.ptt_key_binding";

export function normalizeAdapterAddressSetting(nextAddress: string): string {
  return nextAddress.trim() || DEFAULT_ADAPTER_ADDRESS;
}

export function loadStoredAdapterAddress(): string {
  if (typeof window === "undefined") {
    return DEFAULT_ADAPTER_ADDRESS;
  }

  try {
    const storedAddress = window.localStorage.getItem(ADDRESS_STORAGE_KEY);
    if (storedAddress?.trim()) {
      return storedAddress.trim();
    }
  } catch (error) {
    console.warn("[AdapterPreferences] Failed to load stored adapter address.", error);
  }

  return DEFAULT_ADAPTER_ADDRESS;
}

export function saveStoredAdapterAddress(nextAddress: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(ADDRESS_STORAGE_KEY, nextAddress);
  } catch (error) {
    console.warn("[AdapterPreferences] Failed to persist adapter address.", error);
  }
}

export function loadDesktopScreenshotOnSendEnabled(): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    const storedValue = window.localStorage.getItem(DESKTOP_SCREENSHOT_ON_SEND_STORAGE_KEY);
    if (storedValue === "false") {
      return false;
    }
    if (storedValue === "true") {
      return true;
    }
  } catch (error) {
    console.warn("[AdapterPreferences] Failed to load desktop screenshot preference.", error);
  }
  return true;
}

export function saveDesktopScreenshotOnSendEnabled(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      DESKTOP_SCREENSHOT_ON_SEND_STORAGE_KEY,
      enabled ? "true" : "false",
    );
  } catch (error) {
    console.warn("[AdapterPreferences] Failed to persist desktop screenshot preference.", error);
  }
}

export function normalizeMicrophoneDeviceId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function loadStoredMicrophoneDeviceId(): string {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    return normalizeMicrophoneDeviceId(
      window.localStorage.getItem(MICROPHONE_DEVICE_ID_STORAGE_KEY),
    );
  } catch (error) {
    console.warn("[AdapterPreferences] Failed to load microphone device preference.", error);
    return "";
  }
}

export function saveStoredMicrophoneDeviceId(deviceId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const normalized = normalizeMicrophoneDeviceId(deviceId);
    if (normalized) {
      window.localStorage.setItem(MICROPHONE_DEVICE_ID_STORAGE_KEY, normalized);
    } else {
      window.localStorage.removeItem(MICROPHONE_DEVICE_ID_STORAGE_KEY);
    }
  } catch (error) {
    console.warn("[AdapterPreferences] Failed to persist microphone device preference.", error);
  }
}

export function loadStoredPttKeyBinding(): DesktopPttKeyBinding {
  if (typeof window === "undefined") {
    return DEFAULT_PTT_KEY_BINDING;
  }

  try {
    const storedValue = window.localStorage.getItem(PTT_KEY_BINDING_STORAGE_KEY);
    if (!storedValue) {
      return DEFAULT_PTT_KEY_BINDING;
    }
    return normalizePttKeyBinding(JSON.parse(storedValue));
  } catch (error) {
    console.warn("[AdapterPreferences] Failed to load PTT key binding preference.", error);
    return DEFAULT_PTT_KEY_BINDING;
  }
}

export function saveStoredPttKeyBinding(binding: DesktopPttKeyBinding): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      PTT_KEY_BINDING_STORAGE_KEY,
      JSON.stringify(normalizePttKeyBinding(binding)),
    );
  } catch (error) {
    console.warn("[AdapterPreferences] Failed to persist PTT key binding preference.", error);
  }
}
