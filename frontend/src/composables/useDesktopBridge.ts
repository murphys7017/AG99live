import { reactive, readonly } from "vue";
import type {
  DesktopBaseActionPreview,
  DesktopRuntimeCommand,
  DesktopRuntimeSnapshot,
  DesktopWindowVisibilityState,
} from "../types/desktop";

const CHANNEL_NAME = "ag99live.desktop.runtime";
const SNAPSHOT_STORAGE_KEY = "ag99live.desktop.snapshot";

type BridgeMessage =
  | { kind: "snapshot"; snapshot: DesktopRuntimeSnapshot }
  | { kind: "command"; command: DesktopRuntimeCommand };

const defaultSnapshot: DesktopRuntimeSnapshot = {
  adapterAddress: "127.0.0.1:12396",
  desktopScreenshotOnSendEnabled: true,
  connectionState: "disconnected",
  connectionLabel: "未连接",
  connectionStatusMessage: "等待桌宠窗口启动。",
  aiState: "offline",
  micRequested: false,
  micCapturing: false,
  audioPlaying: false,
  sessionId: "",
  confName: "",
  lastUpdated: "",
  selectedModelName: "",
  selectedModelIconUrl: "",
  recommendedMode: "",
  serverWsUrl: "",
  httpBaseUrl: "",
  stageMessage: "等待桌宠窗口同步当前运行状态。",
  lastSentText: "",
  lastAssistantText: "",
  lastTranscription: "",
  lastImageCount: 0,
  historyEntries: [],
  baseActionPreview: null,
};

const defaultWindowState: DesktopWindowVisibilityState = {
  petVisible: true,
  overlayVisible: true,
  settingsVisible: false,
  historyVisible: false,
  actionLabVisible: false,
};

const state = reactive({
  snapshot: loadSnapshot(),
  windowState: defaultWindowState,
});

let initialized = false;
let channel: BroadcastChannel | null = null;
const commandListeners = new Set<(command: DesktopRuntimeCommand) => void>();

function ensureInitialized(): void {
  if (initialized || typeof window === "undefined") {
    return;
  }

  initialized = true;

  if ("BroadcastChannel" in window) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener("message", (event: MessageEvent<BridgeMessage>) => {
      const payload = event.data;
      if (!payload || typeof payload !== "object") {
        return;
      }

      if (payload.kind === "snapshot") {
        const nextSnapshot = normalizeSnapshot(payload.snapshot);
        state.snapshot = nextSnapshot;
        persistSnapshot(nextSnapshot);
        return;
      }

      if (payload.kind === "command") {
        for (const listener of commandListeners) {
          listener(payload.command);
        }
      }
    });
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== SNAPSHOT_STORAGE_KEY || !event.newValue) {
      return;
    }
    try {
      state.snapshot = normalizeSnapshot(
        JSON.parse(event.newValue) as DesktopRuntimeSnapshot,
      );
    } catch (_error) {
      // Ignore malformed cross-window snapshot writes.
    }
  });

  window.ag99desktop?.onWindowState((nextState) => {
    state.windowState = nextState;
  });
}

function loadSnapshot(): DesktopRuntimeSnapshot {
  if (typeof window === "undefined") {
    return defaultSnapshot;
  }

  const rawValue = window.localStorage.getItem(SNAPSHOT_STORAGE_KEY);
  if (!rawValue) {
    return defaultSnapshot;
  }

  try {
    return normalizeSnapshot(JSON.parse(rawValue) as DesktopRuntimeSnapshot);
  } catch (_error) {
    return defaultSnapshot;
  }
}

function persistSnapshot(snapshot: DesktopRuntimeSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
}

function normalizeSnapshot(snapshot: DesktopRuntimeSnapshot): DesktopRuntimeSnapshot {
  const historyEntries = Array.isArray(snapshot.historyEntries)
    ? snapshot.historyEntries
    : [];
  return {
    ...defaultSnapshot,
    ...snapshot,
    historyEntries: historyEntries.map((entry) => ({ ...entry })),
    baseActionPreview: cloneBaseActionPreview(snapshot.baseActionPreview),
  };
}

function cloneBaseActionPreview(
  preview: DesktopBaseActionPreview | null,
): DesktopBaseActionPreview | null {
  if (!preview) {
    return null;
  }
  return {
    ...preview,
    focusChannels: [...preview.focusChannels],
    focusDomains: [...preview.focusDomains],
    ignoredDomains: [...preview.ignoredDomains],
    summary: { ...preview.summary },
    analysis: { ...preview.analysis },
    families: preview.families.map((family) => ({
      ...family,
      channels: [...family.channels],
    })),
    channels: preview.channels.map((channel) => ({
      ...channel,
      polarityModes: [...channel.polarityModes],
      atomIds: [...channel.atomIds],
    })),
    atoms: preview.atoms.map((atom) => ({
      ...atom,
      sourceTags: [...atom.sourceTags],
    })),
  };
}

export function useDesktopBridge() {
  ensureInitialized();

  function publishSnapshot(snapshot: DesktopRuntimeSnapshot): void {
    const nextSnapshot = normalizeSnapshot(snapshot);
    state.snapshot = nextSnapshot;
    persistSnapshot(nextSnapshot);
    channel?.postMessage({
      kind: "snapshot",
      snapshot: nextSnapshot,
    } satisfies BridgeMessage);
  }

  function sendCommand(command: DesktopRuntimeCommand): void {
    channel?.postMessage({ kind: "command", command } satisfies BridgeMessage);
  }

  function onCommand(callback: (command: DesktopRuntimeCommand) => void): () => void {
    commandListeners.add(callback);
    return () => {
      commandListeners.delete(callback);
    };
  }

  return {
    state: readonly(state),
    publishSnapshot,
    sendCommand,
    onCommand,
  };
}
