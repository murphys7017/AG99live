import { reactive, readonly } from "vue";
import type {
  DesktopBaseActionPreview,
  DesktopMotionPlaybackRecord,
  DesktopMotionTuningSample,
  DesktopRuntimeCommand,
  DesktopRuntimeSnapshot,
  DesktopWindowVisibilityState,
} from "../types/desktop";
import type {
  DirectParameterPlan,
  MotionPlanPayload,
  SemanticParameterPlan,
} from "../types/protocol";
import type { SemanticAxisProfile } from "../types/semantic-axis-profile";
import {
  buildDefaultModelEngineSettings,
  cloneModelEngineSettings,
  normalizeModelEngineSettings,
} from "../model-engine/settings";

const CHANNEL_NAME = "ag99live.desktop.runtime";
const SNAPSHOT_STORAGE_KEY = "ag99live.desktop.snapshot";

type BridgeMessage =
  | { kind: "snapshot"; snapshot: DesktopRuntimeSnapshot }
  | { kind: "command"; command: DesktopRuntimeCommand };

const defaultSnapshot: DesktopRuntimeSnapshot = {
  adapterAddress: "127.0.0.1:12396",
  desktopScreenshotOnSendEnabled: true,
  ambientMotionEnabled: true,
  motionEngineSettings: buildDefaultModelEngineSettings(),
  motionPlaybackRecords: [],
  motionTuningSamples: [],
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
  selectedSemanticAxisProfile: null,
  latestSemanticAxisProfileSaveResult: null,
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
    } catch (error) {
      console.warn("[DesktopBridge] malformed cross-window snapshot rejected.", error);
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
  } catch (error) {
    console.warn("[DesktopBridge] persisted snapshot rejected; using defaults.", error);
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
    motionEngineSettings: cloneModelEngineSettings(
      normalizeModelEngineSettings(snapshot.motionEngineSettings),
    ),
    motionPlaybackRecords: Array.isArray(snapshot.motionPlaybackRecords)
      ? snapshot.motionPlaybackRecords.map(cloneMotionPlaybackRecord).filter(isPresent)
      : [],
    motionTuningSamples: Array.isArray(snapshot.motionTuningSamples)
      ? snapshot.motionTuningSamples.map(cloneMotionTuningSample).filter(isPresent)
      : [],
    historyEntries: historyEntries.map((entry) => ({ ...entry })),
    baseActionPreview: cloneBaseActionPreview(snapshot.baseActionPreview),
    selectedSemanticAxisProfile: cloneSemanticAxisProfile(
      snapshot.selectedSemanticAxisProfile,
    ),
    latestSemanticAxisProfileSaveResult: snapshot.latestSemanticAxisProfileSaveResult
      ? { ...snapshot.latestSemanticAxisProfileSaveResult }
      : null,
  };
}

function cloneMotionPlaybackRecord(
  record: DesktopMotionPlaybackRecord,
): DesktopMotionPlaybackRecord | null {
  try {
    return {
      ...record,
      diagnostics: record.diagnostics
        ? {
          ...record.diagnostics,
          axisIntensityScale: { ...record.diagnostics.axisIntensityScale },
        }
        : null,
      plan: cloneDirectParameterPlan(record.plan),
    };
  } catch (error) {
    console.warn("[DesktopBridge] motion playback record rejected.", error, record);
    return null;
  }
}

function cloneMotionTuningSample(
  sample: DesktopMotionTuningSample,
): DesktopMotionTuningSample | null {
  try {
    return {
      ...sample,
      tags: [...sample.tags],
      enabledForLlmReference: Boolean(sample.enabledForLlmReference),
      originalAxes: { ...sample.originalAxes },
      adjustedAxes: { ...sample.adjustedAxes },
      adjustedPlan: cloneDirectParameterPlan(sample.adjustedPlan),
    };
  } catch (error) {
    console.warn("[DesktopBridge] motion tuning sample rejected.", error, sample);
    return null;
  }
}

function isPresent<TValue>(value: TValue | null): value is TValue {
  return value !== null;
}

function cloneDirectParameterPlan(plan: DirectParameterPlan): DirectParameterPlan;
function cloneDirectParameterPlan(plan: SemanticParameterPlan): SemanticParameterPlan;
function cloneDirectParameterPlan(plan: MotionPlanPayload): MotionPlanPayload;
function cloneDirectParameterPlan(plan: MotionPlanPayload): MotionPlanPayload {
  if (plan.schema_version === "engine.parameter_plan.v2") {
    return {
      ...plan,
      timing: { ...plan.timing },
      parameters: plan.parameters.map((item) => ({ ...item })),
      diagnostics: plan.diagnostics
        ? {
          ...plan.diagnostics,
          warnings: plan.diagnostics.warnings
            ? [...plan.diagnostics.warnings]
            : undefined,
        }
        : undefined,
      summary: plan.summary ? { ...plan.summary } : undefined,
    };
  }

  return {
    ...plan,
    timing: { ...plan.timing },
    key_axes: Object.fromEntries(
      Object.entries(plan.key_axes).map(([axisName, axisValue]) => [
        axisName,
        { ...axisValue },
      ]),
    ) as DirectParameterPlan["key_axes"],
    supplementary_params: plan.supplementary_params.map((item) => ({ ...item })),
    calibration_profile: plan.calibration_profile
      ? {
        ...plan.calibration_profile,
        axes: plan.calibration_profile.axes
          ? { ...plan.calibration_profile.axes }
          : undefined,
        axis_calibrations: plan.calibration_profile.axis_calibrations
          ? { ...plan.calibration_profile.axis_calibrations }
          : undefined,
      }
      : plan.calibration_profile,
    model_calibration_profile: plan.model_calibration_profile
      ? {
        ...plan.model_calibration_profile,
        axes: plan.model_calibration_profile.axes
          ? { ...plan.model_calibration_profile.axes }
          : undefined,
        axis_calibrations: plan.model_calibration_profile.axis_calibrations
          ? { ...plan.model_calibration_profile.axis_calibrations }
          : undefined,
      }
      : plan.model_calibration_profile,
    summary: plan.summary ? { ...plan.summary } : undefined,
  } satisfies DirectParameterPlan;
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

function cloneSemanticAxisProfile(
  profile: SemanticAxisProfile | null | undefined,
): SemanticAxisProfile | null {
  if (!profile) {
    return null;
  }
  return {
    ...profile,
    axes: profile.axes.map((axis) => ({
      ...axis,
      value_range: [...axis.value_range] as [number, number],
      soft_range: [...axis.soft_range] as [number, number],
      strong_range: [...axis.strong_range] as [number, number],
      positive_semantics: [...axis.positive_semantics],
      negative_semantics: [...axis.negative_semantics],
      parameter_bindings: axis.parameter_bindings.map((binding) => ({
        ...binding,
        input_range: [...binding.input_range] as [number, number],
        output_range: [...binding.output_range] as [number, number],
      })),
    })),
    couplings: profile.couplings.map((coupling) => ({ ...coupling })),
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
