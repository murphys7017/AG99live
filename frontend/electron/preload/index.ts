import { contextBridge, ipcRenderer } from "electron";
import os from "node:os";
import type {
  BilibiliDanmakuInfoResult,
  BilibiliLiveSettings,
} from "../../src/types/bilibili-live";
import type {
  DesktopAuxWindowRole,
  DesktopMicrophoneAudioChunk,
  DesktopMicrophoneDevice,
  DesktopPttEventAck,
  DesktopPttHookStatus,
  DesktopPttKeyBinding,
  DesktopWindowVisibilityState,
} from "../../src/types/desktop";

function listLocalAdapterHosts(): string[] {
  const ordered = ["127.0.0.1", "localhost"];
  const seen = new Set(ordered.map((value) => value.toLowerCase()));

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = String(entry.family);
      if ((family !== "IPv4" && family !== "4") || entry.internal || !entry.address) {
        continue;
      }

      const address = entry.address.trim();
      if (!address || seen.has(address.toLowerCase())) {
        continue;
      }

      seen.add(address.toLowerCase());
      ordered.push(address);
    }
  }

  return ordered;
}

const api = {
  showContextMenu: (position?: {
    x?: number;
    y?: number;
    screenX?: number;
    screenY?: number;
  }) => {
    ipcRenderer.send("desktop:show-context-menu", position ?? {});
  },
  setIgnoreMouseEvents: (ignore: boolean) => {
    ipcRenderer.send("desktop:set-ignore-mouse-events", ignore);
  },
  startWindowDrag: (screenX: number, screenY: number) => {
    ipcRenderer.send("desktop:start-window-drag", screenX, screenY);
  },
  updateWindowDrag: (screenX: number, screenY: number) => {
    ipcRenderer.send("desktop:update-window-drag", screenX, screenY);
  },
  endWindowDrag: () => {
    ipcRenderer.send("desktop:end-window-drag");
  },
  getLocalAdapterHosts: () => {
    return listLocalAdapterHosts();
  },
  getBilibiliDanmakuInfo: (settings: BilibiliLiveSettings) => {
    return ipcRenderer.invoke(
      "bilibili-live:get-danmaku-info",
      settings,
    ) as Promise<BilibiliDanmakuInfoResult>;
  },
  captureDesktopScreenshot: () => {
    return ipcRenderer.invoke("desktop:capture-screen-image") as Promise<{
      data: string;
      mime_type: "image/jpeg";
      source: "screen";
      captured_at: string;
    } | null>;
  },
  listNativeMicrophones: () => {
    return ipcRenderer.invoke("desktop:list-native-microphones") as Promise<DesktopMicrophoneDevice[]>;
  },
  startNativeMicrophoneCapture: (deviceId: string | null) => {
    return ipcRenderer.invoke("desktop:start-native-microphone-capture", deviceId) as Promise<
      { ok: true; sessionId: string } | { ok: false; error: string }
    >;
  },
  stopNativeMicrophoneCapture: (sessionId: string) => {
    return ipcRenderer.invoke("desktop:stop-native-microphone-capture", sessionId) as Promise<boolean>;
  },
  toggleAuxWindow: (target: DesktopAuxWindowRole) => {
    ipcRenderer.send("desktop:toggle-aux-window", target);
  },
  closeCurrentWindow: () => {
    ipcRenderer.send("desktop:close-current-window");
  },
  minimizeCurrentWindow: () => {
    ipcRenderer.send("desktop:minimize-current-window");
  },
  setPttMode: (enabled: boolean, binding?: DesktopPttKeyBinding) => {
    ipcRenderer.send("desktop:set-ptt-mode", enabled, binding);
  },
  getPttHookStatus: () => {
    return ipcRenderer.invoke("desktop:get-ptt-hook-status") as Promise<DesktopPttHookStatus>;
  },
  reportPttEventAck: (ack: DesktopPttEventAck) => {
    ipcRenderer.send("desktop:ptt-event-ack", ack);
  },
  sendRuntimeBridgeMessage: (payload: unknown) => {
    ipcRenderer.send("desktop:runtime-bridge-message", payload);
  },
  onRuntimeBridgeMessage: (callback: (payload: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => {
      callback(payload);
    };
    ipcRenderer.on("desktop:runtime-bridge-message", handler);
    return () => {
      ipcRenderer.removeListener("desktop:runtime-bridge-message", handler);
    };
  },
  onIpc: <TPayload = unknown>(channel: string, callback: (payload: TPayload) => void) => {
    const handler = (_event: unknown, payload: TPayload) => {
      callback(payload);
    };
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
  onPttHookStatus: (
    callback: (payload: DesktopPttHookStatus) => void,
  ) => {
    const handler = (_event: unknown, payload: DesktopPttHookStatus) => {
      callback(payload);
    };
    ipcRenderer.on("desktop:ptt-hook-status", handler);
    return () => {
      ipcRenderer.removeListener("desktop:ptt-hook-status", handler);
    };
  },
  onNativeMicrophoneChunk: (
    callback: (chunk: DesktopMicrophoneAudioChunk & { sessionId: string }) => void,
  ) => {
    const handler = (_event: unknown, payload: DesktopMicrophoneAudioChunk & { sessionId: string }) => {
      callback(payload);
    };
    ipcRenderer.on("desktop:native-microphone-chunk", handler);
    return () => {
      ipcRenderer.removeListener("desktop:native-microphone-chunk", handler);
    };
  },
  onNativeMicrophoneEnded: (
    callback: (payload: { sessionId: string; reason: string }) => void,
  ) => {
    const handler = (_event: unknown, payload: { sessionId: string; reason: string }) => {
      callback(payload);
    };
    ipcRenderer.on("desktop:native-microphone-ended", handler);
    return () => {
      ipcRenderer.removeListener("desktop:native-microphone-ended", handler);
    };
  },
  onNativeMicrophoneError: (
    callback: (payload: { sessionId: string; error: string }) => void,
  ) => {
    const handler = (_event: unknown, payload: { sessionId: string; error: string }) => {
      callback(payload);
    };
    ipcRenderer.on("desktop:native-microphone-error", handler);
    return () => {
      ipcRenderer.removeListener("desktop:native-microphone-error", handler);
    };
  },
  onWindowState: (
    callback: (state: DesktopWindowVisibilityState) => void,
  ) => {
    const handler = (_event: unknown, state: DesktopWindowVisibilityState) => {
      callback(state);
    };

    ipcRenderer.on("desktop-window-state", handler);
    return () => {
      ipcRenderer.removeListener("desktop-window-state", handler);
    };
  },
  onForceRedraw: (callback: () => void) => {
    const handler = () => {
      callback();
    };

    ipcRenderer.on("desktop-force-redraw", handler);
    return () => {
      ipcRenderer.removeListener("desktop-force-redraw", handler);
    };
  },
  startEsp32Display: (host: string, port: number, timeoutSeconds?: number) => {
    return ipcRenderer.invoke("esp32-display:start", {
      host,
      port,
      timeoutSeconds,
    }) as Promise<{ ok: boolean; error?: string }>;
  },
  stopEsp32Display: () => {
    return ipcRenderer.invoke("esp32-display:stop") as Promise<{ ok: boolean }>;
  },
  sendEsp32DisplayFrame: (jpeg: Uint8Array) => {
    return ipcRenderer.invoke("esp32-display:send-frame", { jpeg }) as Promise<{
      ok: boolean;
      error?: string;
    }>;
  },
  getEsp32DisplayStatus: () => {
    return ipcRenderer.invoke("esp32-display:status") as Promise<{
      connected: boolean;
      error: string;
    }>;
  },
  onEsp32DisplayStatus: (
    callback: (payload: { connected: boolean; error: string }) => void,
  ) => {
    const handler = (_event: unknown, payload: { connected: boolean; error: string }) => {
      callback(payload);
    };
    ipcRenderer.on("esp32-display:status", handler);
    return () => {
      ipcRenderer.removeListener("esp32-display:status", handler);
    };
  },
};

const hasContextIsolation = Boolean(
  (process as NodeJS.Process & { contextIsolated?: boolean }).contextIsolated,
);

if (hasContextIsolation) {
  contextBridge.exposeInMainWorld("ag99desktop", api);
} else {
  const target = window as Window & {
    ag99desktop?: typeof api;
  };
  target.ag99desktop = api;
}
