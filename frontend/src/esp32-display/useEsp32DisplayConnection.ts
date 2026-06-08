import { onBeforeUnmount, ref, type Ref } from "vue";
import type { Esp32DisplayConfig } from "./types";

export interface Esp32DisplayConnection {
  connected: Ref<boolean>;
  lastError: Ref<string>;
  start: (config: Esp32DisplayConfig) => Promise<boolean>;
  stop: () => Promise<void>;
}

interface DesktopBridge {
  startEsp32Display: (host: string, port: number, timeoutSeconds?: number) => Promise<{ ok: boolean; error?: string }>;
  stopEsp32Display: () => Promise<{ ok: boolean }>;
  sendEsp32DisplayFrame: (jpeg: Uint8Array) => Promise<{ ok: boolean; error?: string }>;
  getEsp32DisplayStatus: () => Promise<{ connected: boolean; error: string }>;
  onEsp32DisplayStatus: (callback: (payload: { connected: boolean; error: string }) => void) => () => void;
}

function getBridge(): DesktopBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const candidate = (window as Window & { ag99desktop?: DesktopBridge }).ag99desktop;
  if (!candidate) {
    return null;
  }
  const required: (keyof DesktopBridge)[] = [
    "startEsp32Display",
    "stopEsp32Display",
    "sendEsp32DisplayFrame",
    "getEsp32DisplayStatus",
    "onEsp32DisplayStatus",
  ];
  for (const key of required) {
    if (typeof candidate[key] !== "function") {
      return null;
    }
  }
  return candidate;
}

export function useEsp32DisplayConnection(): Esp32DisplayConnection {
  const bridge = getBridge();
  const connected = ref(false);
  const lastError = ref("");
  let removeListener: (() => void) | null = null;

  if (bridge) {
    removeListener = bridge.onEsp32DisplayStatus((payload) => {
      connected.value = payload.connected;
      lastError.value = payload.error;
    });
    bridge.getEsp32DisplayStatus()
      .then((status) => {
        connected.value = status.connected;
        lastError.value = status.error;
      })
      .catch(() => {
        // ignore
      });
  }

  async function start(config: Esp32DisplayConfig): Promise<boolean> {
    if (!bridge) {
      lastError.value = "preload_unavailable";
      return false;
    }
    let result: { ok: boolean; error?: string };
    try {
      result = await bridge.startEsp32Display(config.host, config.port, 8);
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : "ipc_start_failed";
      connected.value = false;
      return false;
    }
    if (!result.ok) {
      lastError.value = result.error ?? "start_failed";
      connected.value = false;
      return false;
    }
    connected.value = true;
    lastError.value = "";
    return true;
  }

  async function stop(): Promise<void> {
    if (!bridge) {
      return;
    }
    try {
      await bridge.stopEsp32Display();
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : "ipc_stop_failed";
    }
    connected.value = false;
  }

  onBeforeUnmount(() => {
    removeListener?.();
    removeListener = null;
  });

  return { connected, lastError, start, stop };
}

export async function sendEsp32DisplayFrame(jpeg: Uint8Array): Promise<boolean> {
  const bridge = getBridge();
  if (!bridge) {
    return false;
  }
  try {
    const result = await bridge.sendEsp32DisplayFrame(jpeg);
    return result.ok;
  } catch (error) {
    console.warn("[Esp32Display] send frame failed.", error);
    return false;
  }
}
