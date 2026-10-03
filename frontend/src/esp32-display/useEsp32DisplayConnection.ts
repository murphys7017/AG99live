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

export async function startEsp32DisplayConnection(
  config: Esp32DisplayConfig,
  timeoutSeconds = 8,
): Promise<{ ok: boolean; error?: string }> {
  const bridge = getBridge();
  if (!bridge) {
    return { ok: false, error: "preload_unavailable" };
  }
  try {
    return await bridge.startEsp32Display(config.host, config.port, timeoutSeconds);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "ipc_start_failed",
    };
  }
}

export async function stopEsp32DisplayConnection(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const bridge = getBridge();
  if (!bridge) {
    return { ok: true };
  }
  try {
    return await bridge.stopEsp32Display();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "ipc_stop_failed",
    };
  }
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
      .catch((error) => {
        connected.value = false;
        lastError.value = error instanceof Error
          ? error.message
          : "ipc_status_failed";
        console.warn("[Esp32Display] read connection status failed.", error);
      });
  }

  async function start(config: Esp32DisplayConfig): Promise<boolean> {
    if (!bridge) {
      lastError.value = "preload_unavailable";
      return false;
    }
    const result = await startEsp32DisplayConnection(config);
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
    const result = await stopEsp32DisplayConnection();
    if (!result.ok) {
      lastError.value = result.error ?? "ipc_stop_failed";
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
