import { reactive, readonly } from "vue";
import type {
  DesktopProfileAuthoringCommand,
  DesktopProfileAuthoringSnapshot,
  DesktopMotionTuningSample,
  DesktopMotionTuningSamplesStatus,
  DesktopRuntimeCommand,
  DesktopRuntimeSnapshot,
  DesktopWindowVisibilityState,
} from "../types/desktop";
import {
  defaultProfileAuthoringSnapshot,
  defaultSnapshot,
  normalizeMotionTuningSamples,
  normalizeMotionTuningSamplesStatus,
  normalizeProfileAuthoringSnapshot,
  normalizeSnapshot,
  safeNormalizeProfileAuthoringSnapshot,
  safeNormalizeSnapshot,
} from "../desktop-bridge/snapshot";

const RUNTIME_CHANNEL_NAME = "ag99live.desktop.runtime";
const PROFILE_AUTHORING_CHANNEL_NAME = "ag99live.desktop.profile_authoring";
const RUNTIME_SNAPSHOT_STORAGE_KEY = "ag99live.desktop.snapshot";
const PROFILE_AUTHORING_SNAPSHOT_STORAGE_KEY = "ag99live.desktop.profile_authoring.snapshot";

type RuntimeBridgeMessage =
  | { kind: "snapshot"; snapshot: DesktopRuntimeSnapshot }
  | {
    kind: "motion_tuning_samples";
    samples: DesktopMotionTuningSample[];
    status?: DesktopMotionTuningSamplesStatus;
  }
  | { kind: "command"; command: DesktopRuntimeCommand };

type ProfileAuthoringBridgeMessage =
  | {
    kind: "profile_authoring_snapshot";
    snapshot: DesktopProfileAuthoringSnapshot;
  }
  | {
    kind: "profile_authoring_command";
    command: DesktopProfileAuthoringCommand;
  };

const defaultWindowState: DesktopWindowVisibilityState = {
  petVisible: true,
  overlayVisible: true,
  settingsVisible: false,
  historyVisible: false,
  actionLabVisible: false,
};

const state = reactive({
  snapshot: loadRuntimeSnapshot(),
  motionTuningSamples: [] as DesktopMotionTuningSample[],
  motionTuningSamplesStatus: {
    rootError: "",
    loadError: "",
    diagnostics: [],
  } as DesktopMotionTuningSamplesStatus,
  profileAuthoringSnapshot: loadProfileAuthoringSnapshot(),
  windowState: defaultWindowState,
});

let initialized = false;
let runtimeChannel: BroadcastChannel | null = null;
let profileAuthoringChannel: BroadcastChannel | null = null;
const commandListeners = new Set<(command: DesktopRuntimeCommand) => void>();
const profileAuthoringCommandListeners = new Set<
  (command: DesktopProfileAuthoringCommand) => void
>();

function ensureInitialized(): void {
  if (initialized || typeof window === "undefined") {
    return;
  }

  initialized = true;

  if ("BroadcastChannel" in window) {
    runtimeChannel = new BroadcastChannel(RUNTIME_CHANNEL_NAME);
    runtimeChannel.addEventListener("message", (event: MessageEvent<RuntimeBridgeMessage>) => {
      const payload = event.data;
      if (!payload || typeof payload !== "object") {
        return;
      }

      if (payload.kind === "snapshot") {
        const nextSnapshot = safeNormalizeSnapshot(payload.snapshot, "broadcast");
        if (!nextSnapshot) {
          return;
        }
        state.snapshot = nextSnapshot;
        persistRuntimeSnapshot(nextSnapshot);
        return;
      }

      if (payload.kind === "motion_tuning_samples") {
        state.motionTuningSamples = normalizeMotionTuningSamples(payload.samples);
        state.motionTuningSamplesStatus = normalizeMotionTuningSamplesStatus(payload.status);
        return;
      }

      if (payload.kind === "command") {
        for (const listener of commandListeners) {
          listener(payload.command);
        }
      }
    });

    profileAuthoringChannel = new BroadcastChannel(PROFILE_AUTHORING_CHANNEL_NAME);
    profileAuthoringChannel.addEventListener(
      "message",
      (event: MessageEvent<ProfileAuthoringBridgeMessage>) => {
        const payload = event.data;
        if (!payload || typeof payload !== "object") {
          return;
        }

        if (payload.kind === "profile_authoring_command") {
          for (const listener of profileAuthoringCommandListeners) {
            listener(payload.command);
          }
          return;
        }

        if (payload.kind !== "profile_authoring_snapshot") {
          return;
        }

        const nextSnapshot = safeNormalizeProfileAuthoringSnapshot(
          payload.snapshot,
          "broadcast",
        );
        if (!nextSnapshot) {
          return;
        }
        state.profileAuthoringSnapshot = nextSnapshot;
        persistProfileAuthoringSnapshot(nextSnapshot);
      },
    );
  }

  window.addEventListener("storage", (event) => {
    if (event.key === RUNTIME_SNAPSHOT_STORAGE_KEY && event.newValue) {
      try {
        state.snapshot = normalizeSnapshot(
          JSON.parse(event.newValue) as DesktopRuntimeSnapshot,
        );
      } catch (error) {
        console.warn("[DesktopBridge] malformed cross-window snapshot rejected.", error);
      }
      return;
    }

    if (event.key === PROFILE_AUTHORING_SNAPSHOT_STORAGE_KEY && event.newValue) {
      try {
        state.profileAuthoringSnapshot = normalizeProfileAuthoringSnapshot(
          JSON.parse(event.newValue) as DesktopProfileAuthoringSnapshot,
        );
      } catch (error) {
        console.warn(
          "[DesktopBridge] malformed cross-window profile authoring snapshot rejected.",
          error,
        );
      }
    }
  });

  window.ag99desktop?.onWindowState((nextState) => {
    state.windowState = nextState;
  });
}

function loadRuntimeSnapshot(): DesktopRuntimeSnapshot {
  if (typeof window === "undefined") {
    return defaultSnapshot;
  }

  const rawValue = window.localStorage.getItem(RUNTIME_SNAPSHOT_STORAGE_KEY);
  if (!rawValue) {
    return defaultSnapshot;
  }

  try {
    const nextSnapshot = safeNormalizeSnapshot(JSON.parse(rawValue), "storage");
    if (nextSnapshot) {
      return nextSnapshot;
    }
    window.localStorage.removeItem(RUNTIME_SNAPSHOT_STORAGE_KEY);
    return defaultSnapshot;
  } catch (error) {
    console.warn("[DesktopBridge] persisted snapshot rejected; using defaults.", error);
    window.localStorage.removeItem(RUNTIME_SNAPSHOT_STORAGE_KEY);
    return defaultSnapshot;
  }
}

function loadProfileAuthoringSnapshot(): DesktopProfileAuthoringSnapshot {
  if (typeof window === "undefined") {
    return defaultProfileAuthoringSnapshot;
  }

  const rawValue = window.localStorage.getItem(PROFILE_AUTHORING_SNAPSHOT_STORAGE_KEY);
  if (!rawValue) {
    return defaultProfileAuthoringSnapshot;
  }

  try {
    const nextSnapshot = safeNormalizeProfileAuthoringSnapshot(
      JSON.parse(rawValue),
      "storage",
    );
    if (nextSnapshot) {
      return nextSnapshot;
    }
    window.localStorage.removeItem(PROFILE_AUTHORING_SNAPSHOT_STORAGE_KEY);
    return defaultProfileAuthoringSnapshot;
  } catch (error) {
    console.warn(
      "[DesktopBridge] persisted profile authoring snapshot rejected; using defaults.",
      error,
    );
    window.localStorage.removeItem(PROFILE_AUTHORING_SNAPSHOT_STORAGE_KEY);
    return defaultProfileAuthoringSnapshot;
  }
}

function persistRuntimeSnapshot(snapshot: DesktopRuntimeSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(RUNTIME_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
}

function persistProfileAuthoringSnapshot(
  snapshot: DesktopProfileAuthoringSnapshot,
): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(
    PROFILE_AUTHORING_SNAPSHOT_STORAGE_KEY,
    JSON.stringify(snapshot),
  );
}

export function useDesktopBridge() {
  ensureInitialized();

  function publishSnapshot(snapshot: DesktopRuntimeSnapshot): void {
    const nextSnapshot = safeNormalizeSnapshot(snapshot, "publish");
    if (!nextSnapshot) {
      throw new Error("[DesktopBridge] publish snapshot rejected.");
    }
    state.snapshot = nextSnapshot;
    persistRuntimeSnapshot(nextSnapshot);
    runtimeChannel?.postMessage({
      kind: "snapshot",
      snapshot: nextSnapshot,
    } satisfies RuntimeBridgeMessage);
  }

  function publishMotionTuningSamples(
    samples: unknown,
    status?: DesktopMotionTuningSamplesStatus,
  ): void {
    const nextSamples = normalizeMotionTuningSamples(samples);
    const nextStatus = normalizeMotionTuningSamplesStatus(status);
    state.motionTuningSamples = nextSamples;
    state.motionTuningSamplesStatus = nextStatus;
    runtimeChannel?.postMessage({
      kind: "motion_tuning_samples",
      samples: nextSamples,
      status: nextStatus,
    } satisfies RuntimeBridgeMessage);
  }

  function publishProfileAuthoringSnapshot(
    snapshot: DesktopProfileAuthoringSnapshot,
  ): void {
    const nextSnapshot = safeNormalizeProfileAuthoringSnapshot(snapshot, "publish");
    if (!nextSnapshot) {
      throw new Error("[DesktopBridge] publish profile authoring snapshot rejected.");
    }
    state.profileAuthoringSnapshot = nextSnapshot;
    persistProfileAuthoringSnapshot(nextSnapshot);
    profileAuthoringChannel?.postMessage({
      kind: "profile_authoring_snapshot",
      snapshot: nextSnapshot,
    } satisfies ProfileAuthoringBridgeMessage);
  }

  function sendCommand(command: DesktopRuntimeCommand): void {
    runtimeChannel?.postMessage({
      kind: "command",
      command,
    } satisfies RuntimeBridgeMessage);
  }

  function sendProfileAuthoringCommand(
    command: DesktopProfileAuthoringCommand,
  ): void {
    profileAuthoringChannel?.postMessage({
      kind: "profile_authoring_command",
      command,
    } satisfies ProfileAuthoringBridgeMessage);
  }

  function onCommand(callback: (command: DesktopRuntimeCommand) => void): () => void {
    commandListeners.add(callback);
    return () => {
      commandListeners.delete(callback);
    };
  }

  function onProfileAuthoringCommand(
    callback: (command: DesktopProfileAuthoringCommand) => void,
  ): () => void {
    profileAuthoringCommandListeners.add(callback);
    return () => {
      profileAuthoringCommandListeners.delete(callback);
    };
  }

  return {
    state: readonly(state),
    publishSnapshot,
    publishMotionTuningSamples,
    publishProfileAuthoringSnapshot,
    sendCommand,
    sendProfileAuthoringCommand,
    onCommand,
    onProfileAuthoringCommand,
  };
}
