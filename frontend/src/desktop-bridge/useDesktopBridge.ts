import {
  inject,
  reactive,
  readonly,
  type InjectionKey,
} from "vue";
import type {
  DeepReadonly,
} from "vue";
import type {
  DesktopModelProjectionSnapshot,
  DesktopProfileAuthoringCommand,
  DesktopProfileAuthoringSnapshot,
  DesktopMotionTuningSample,
  DesktopMotionTuningSamplesStatus,
  DesktopRuntimeCommand,
  DesktopRuntimeSnapshot,
  DesktopWindowVisibilityState,
} from "../types/desktop";
import {
  defaultModelProjectionSnapshot,
  defaultProfileAuthoringSnapshot,
  defaultSnapshot,
  normalizeModelProjectionSnapshot,
  normalizeMotionTuningSamples,
  normalizeMotionTuningSamplesStatus,
  normalizeProfileAuthoringSnapshot,
  normalizeSnapshot,
  safeNormalizeModelProjectionSnapshot,
  safeNormalizeProfileAuthoringSnapshot,
  safeNormalizeSnapshot,
} from "./snapshot.js";
import { cloneJson } from "../utils/cloneJson.js";

const RUNTIME_CHANNEL_NAME = "ag99live.desktop.runtime";
const PROFILE_AUTHORING_CHANNEL_NAME = "ag99live.desktop.profile_authoring";
const RUNTIME_SNAPSHOT_STORAGE_KEY = "ag99live.desktop.snapshot";
const PROFILE_AUTHORING_SNAPSHOT_STORAGE_KEY = "ag99live.desktop.profile_authoring.snapshot";

type RuntimeBridgeMessage =
  | { kind: "snapshot"; snapshot: DesktopRuntimeSnapshot }
  | { kind: "model_projection"; snapshot: DesktopModelProjectionSnapshot }
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

interface DesktopBridgeState {
  snapshot: DesktopRuntimeSnapshot;
  modelProjectionSnapshot: DesktopModelProjectionSnapshot;
  motionTuningSamples: DesktopMotionTuningSample[];
  motionTuningSamplesStatus: DesktopMotionTuningSamplesStatus;
  profileAuthoringSnapshot: DesktopProfileAuthoringSnapshot;
  windowState: DesktopWindowVisibilityState;
}

export interface DesktopBridgeInstance {
  state: DeepReadonly<DesktopBridgeState>;
  start: () => void;
  dispose: () => void;
  publishSnapshot: (snapshot: DesktopRuntimeSnapshot) => void;
  publishModelProjectionSnapshot: (snapshot: DesktopModelProjectionSnapshot) => void;
  publishMotionTuningSamples: (
    samples: unknown,
    status?: DesktopMotionTuningSamplesStatus,
  ) => void;
  publishProfileAuthoringSnapshot: (
    snapshot: DesktopProfileAuthoringSnapshot,
  ) => void;
  sendCommand: (command: DesktopRuntimeCommand) => void;
  sendProfileAuthoringCommand: (command: DesktopProfileAuthoringCommand) => void;
  onCommand: (callback: (command: DesktopRuntimeCommand) => void) => () => void;
  onProfileAuthoringCommand: (
    callback: (command: DesktopProfileAuthoringCommand) => void,
  ) => () => void;
}

export const desktopBridgeKey: InjectionKey<DesktopBridgeInstance> =
  Symbol("AG99liveDesktopBridge");

const defaultWindowState: DesktopWindowVisibilityState = {
  petVisible: true,
  overlayVisible: true,
  settingsVisible: false,
  historyVisible: false,
  actionLabVisible: false,
};

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

function loadModelProjectionSnapshot(): DesktopModelProjectionSnapshot {
  return normalizeModelProjectionSnapshot(defaultModelProjectionSnapshot);
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
  try {
    window.localStorage.setItem(RUNTIME_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn("[DesktopBridge] Failed to persist runtime snapshot.", error);
  }
}

function persistProfileAuthoringSnapshot(
  snapshot: DesktopProfileAuthoringSnapshot,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      PROFILE_AUTHORING_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(snapshot),
    );
  } catch (error) {
    console.warn("[DesktopBridge] Failed to persist profile authoring snapshot.", error);
  }
}

function reuseStableRuntimeSnapshotCollections(
  previous: DesktopRuntimeSnapshot,
  next: DesktopRuntimeSnapshot,
): DesktopRuntimeSnapshot {
  return {
    ...next,
    microphoneDevices: sameCollection(
      previous.microphoneDevices,
      next.microphoneDevices,
      (item) => `${item.deviceId}:${item.label}`,
    )
      ? previous.microphoneDevices
      : next.microphoneDevices,
    historyEntries: sameCollection(
      previous.historyEntries,
      next.historyEntries,
      (item) => `${item.id}:${item.role}:${item.timestamp}:${item.text}`,
    )
      ? previous.historyEntries
      : next.historyEntries,
    backendHistorySummaries: sameCollection(
      previous.backendHistorySummaries,
      next.backendHistorySummaries,
      (item) => `${item.uid}:${item.timestamp}:${item.latestMessage?.timestamp ?? ""}:${item.latestMessage?.content ?? ""}`,
    )
      ? previous.backendHistorySummaries
      : next.backendHistorySummaries,
    backendHistoryEntries: sameCollection(
      previous.backendHistoryEntries,
      next.backendHistoryEntries,
      (item) => `${item.id}:${item.timestamp}:${item.role}:${item.type}:${item.content}:${item.status ?? ""}`,
    )
      ? previous.backendHistoryEntries
      : next.backendHistoryEntries,
    motionPlaybackRecords: sameCollection(
      previous.motionPlaybackRecords,
      next.motionPlaybackRecords,
      (item) => `${item.id}:${item.createdAt}:${item.payloadKind}:${item.playbackTurnId ?? ""}`,
    )
      ? previous.motionPlaybackRecords
      : next.motionPlaybackRecords,
  };
}

function sameCollection<T>(
  previous: readonly T[],
  next: readonly T[],
  signature: (item: T) => string,
): boolean {
  if (previous.length !== next.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (signature(previous[index]) !== signature(next[index])) {
      return false;
    }
  }
  return true;
}

export function createDesktopBridge(): DesktopBridgeInstance {
  const state = reactive<DesktopBridgeState>({
    snapshot: loadRuntimeSnapshot(),
    modelProjectionSnapshot: loadModelProjectionSnapshot(),
    motionTuningSamples: [],
    motionTuningSamplesStatus: {
      rootError: "",
      loadError: "",
      diagnostics: [],
      effectiveExamples: [],
    },
    profileAuthoringSnapshot: loadProfileAuthoringSnapshot(),
    windowState: defaultWindowState,
  });

  let started = false;
  let runtimeChannel: BroadcastChannel | null = null;
  let profileAuthoringChannel: BroadcastChannel | null = null;
  let removeStorageListener: (() => void) | null = null;
  let removeWindowStateListener: (() => void) | null = null;
  const commandListeners = new Set<(command: DesktopRuntimeCommand) => void>();
  const profileAuthoringCommandListeners = new Set<
    (command: DesktopProfileAuthoringCommand) => void
  >();

  function start(): void {
    if (started || typeof window === "undefined") {
      return;
    }

    started = true;

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
          const stabilizedSnapshot = reuseStableRuntimeSnapshotCollections(
            state.snapshot,
            nextSnapshot,
          );
          state.snapshot = stabilizedSnapshot;
          persistRuntimeSnapshot(stabilizedSnapshot);
          return;
        }

        if (payload.kind === "model_projection") {
          const nextSnapshot = safeNormalizeModelProjectionSnapshot(
            payload.snapshot,
            "broadcast",
          );
          if (!nextSnapshot) {
            return;
          }
          state.modelProjectionSnapshot = nextSnapshot;
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

    const onStorage = (event: StorageEvent) => {
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
    };
    window.addEventListener("storage", onStorage);
    removeStorageListener = () => {
      window.removeEventListener("storage", onStorage);
    };

    const detachWindowState = window.ag99desktop?.onWindowState((nextState: DesktopWindowVisibilityState) => {
      state.windowState = nextState;
    });
    removeWindowStateListener = () => {
      detachWindowState?.();
    };
  }

  function dispose(): void {
    if (!started) {
      return;
    }

    started = false;
    removeStorageListener?.();
    removeStorageListener = null;
    removeWindowStateListener?.();
    removeWindowStateListener = null;
    runtimeChannel?.close();
    runtimeChannel = null;
    profileAuthoringChannel?.close();
    profileAuthoringChannel = null;
    commandListeners.clear();
    profileAuthoringCommandListeners.clear();
  }

  function publishSnapshot(snapshot: DesktopRuntimeSnapshot): void {
    const nextSnapshot = safeNormalizeSnapshot(snapshot, "publish");
    if (!nextSnapshot) {
      throw new Error("[DesktopBridge] publish snapshot rejected.");
    }
    const stabilizedSnapshot = reuseStableRuntimeSnapshotCollections(
      state.snapshot,
      nextSnapshot,
    );
    state.snapshot = stabilizedSnapshot;
    persistRuntimeSnapshot(stabilizedSnapshot);
    const broadcastSnapshot = cloneJson(stabilizedSnapshot);
    runtimeChannel?.postMessage({
      kind: "snapshot",
      snapshot: broadcastSnapshot,
    } satisfies RuntimeBridgeMessage);
  }

  function publishModelProjectionSnapshot(
    snapshot: DesktopModelProjectionSnapshot,
  ): void {
    const nextSnapshot = safeNormalizeModelProjectionSnapshot(snapshot, "publish");
    if (!nextSnapshot) {
      throw new Error("[DesktopBridge] publish model projection snapshot rejected.");
    }
    state.modelProjectionSnapshot = nextSnapshot;
    const broadcastSnapshot = cloneJson(nextSnapshot);
    runtimeChannel?.postMessage({
      kind: "model_projection",
      snapshot: broadcastSnapshot,
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
      samples: cloneJson(nextSamples),
      status: cloneJson(nextStatus),
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
    const broadcastSnapshot = cloneJson(nextSnapshot);
    profileAuthoringChannel?.postMessage({
      kind: "profile_authoring_snapshot",
      snapshot: broadcastSnapshot,
    } satisfies ProfileAuthoringBridgeMessage);
  }

  function sendCommand(command: DesktopRuntimeCommand): void {
    runtimeChannel?.postMessage({
      kind: "command",
      command: cloneJson(command),
    } satisfies RuntimeBridgeMessage);
  }

  function sendProfileAuthoringCommand(
    command: DesktopProfileAuthoringCommand,
  ): void {
    profileAuthoringChannel?.postMessage({
      kind: "profile_authoring_command",
      command: cloneJson(command),
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
    start,
    dispose,
    publishSnapshot,
    publishModelProjectionSnapshot,
    publishMotionTuningSamples,
    publishProfileAuthoringSnapshot,
    sendCommand,
    sendProfileAuthoringCommand,
    onCommand,
    onProfileAuthoringCommand,
  };
}

export function useDesktopBridge(): DesktopBridgeInstance {
  const bridge = inject(desktopBridgeKey, null);
  if (!bridge) {
    throw new Error("[DesktopBridge] no bridge instance was provided.");
  }
  return bridge;
}
