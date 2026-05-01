import { DEFAULT_ADAPTER_ADDRESS } from "./address";

const ADDRESS_STORAGE_KEY = "ag99live.adapter.address";
const DESKTOP_SCREENSHOT_ON_SEND_STORAGE_KEY = "ag99live.desktop.capture_on_send";

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
