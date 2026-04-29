import { reactive, readonly } from "vue";
import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopBaseActionPreview,
  DesktopMotionPlaybackRecord,
  DesktopProfileAuthoringCommand,
  DesktopProfileAuthoringSnapshot,
  DesktopMotionTuningSample,
  DesktopRuntimeCommand,
  DesktopRuntimeSnapshot,
  DesktopWindowVisibilityState,
} from "../types/desktop";
import type {
  SemanticParameterPlan,
} from "../types/protocol";
import type { SemanticAxisProfile } from "../types/semantic-axis-profile";
import {
  buildDefaultModelEngineSettings,
  cloneModelEngineSettings,
  normalizeModelEngineSettings,
} from "../model-engine/settings";

const RUNTIME_CHANNEL_NAME = "ag99live.desktop.runtime";
const PROFILE_AUTHORING_CHANNEL_NAME = "ag99live.desktop.profile_authoring";
const RUNTIME_SNAPSHOT_STORAGE_KEY = "ag99live.desktop.snapshot";
const PROFILE_AUTHORING_SNAPSHOT_STORAGE_KEY = "ag99live.desktop.profile_authoring.snapshot";

type RuntimeBridgeMessage =
  | { kind: "snapshot"; snapshot: DesktopRuntimeSnapshot }
  | { kind: "motion_tuning_samples"; samples: DesktopMotionTuningSample[] }
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

const defaultSnapshot: DesktopRuntimeSnapshot = {
  adapterAddress: "127.0.0.1:12396",
  desktopScreenshotOnSendEnabled: true,
  ambientMotionEnabled: true,
  motionEngineSettings: buildDefaultModelEngineSettings(),
  motionPlaybackRecords: [],
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
  backendHistorySummaries: [],
  backendHistoryEntries: [],
  activeBackendHistoryUid: "",
  backendHistoryLoading: false,
  backendHistoryStatusMessage: "等待桌宠窗口同步后端历史。",
  runtimeSemanticAxisProfile: null,
  baseActionPreview: null,
};

const defaultProfileAuthoringSnapshot: DesktopProfileAuthoringSnapshot = {
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
  snapshot: loadRuntimeSnapshot(),
  motionTuningSamples: [] as DesktopMotionTuningSample[],
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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeNormalizeSnapshot(
  snapshot: unknown,
  source: string,
): DesktopRuntimeSnapshot | null {
  try {
    if (!isObject(snapshot)) {
      throw new Error("snapshot_not_object");
    }
    return normalizeSnapshot(snapshot as unknown as DesktopRuntimeSnapshot);
  } catch (error) {
    console.warn(`[DesktopBridge] ${source} snapshot rejected.`, error);
    return null;
  }
}

function safeNormalizeProfileAuthoringSnapshot(
  snapshot: unknown,
  source: string,
): DesktopProfileAuthoringSnapshot | null {
  try {
    if (!isObject(snapshot)) {
      throw new Error("profile_authoring_snapshot_not_object");
    }
    return normalizeProfileAuthoringSnapshot(
      snapshot as unknown as DesktopProfileAuthoringSnapshot,
    );
  } catch (error) {
    console.warn(
      `[DesktopBridge] ${source} profile authoring snapshot rejected.`,
      error,
    );
    return null;
  }
}

function normalizeSnapshot(snapshot: DesktopRuntimeSnapshot): DesktopRuntimeSnapshot {
  const snapshotWithoutLegacyProfile = {
    ...(snapshot as DesktopRuntimeSnapshot & {
      selectedSemanticAxisProfile?: SemanticAxisProfile | null;
      latestSemanticAxisProfileSaveResult?: unknown;
      motionTuningSamples?: unknown;
    }),
  };
  delete snapshotWithoutLegacyProfile.selectedSemanticAxisProfile;
  delete snapshotWithoutLegacyProfile.latestSemanticAxisProfileSaveResult;
  delete snapshotWithoutLegacyProfile.motionTuningSamples;
  const historyEntries = Array.isArray(snapshot.historyEntries)
    ? snapshot.historyEntries
    : [];
  const backendHistorySummaries = Array.isArray(snapshot.backendHistorySummaries)
    ? snapshot.backendHistorySummaries
    : [];
  const backendHistoryEntries = Array.isArray(snapshot.backendHistoryEntries)
    ? snapshot.backendHistoryEntries
    : [];
  return {
    ...defaultSnapshot,
    ...snapshotWithoutLegacyProfile,
    motionEngineSettings: cloneModelEngineSettings(
      normalizeModelEngineSettings(snapshot.motionEngineSettings),
    ),
    motionPlaybackRecords: Array.isArray(snapshot.motionPlaybackRecords)
      ? snapshot.motionPlaybackRecords.map(cloneMotionPlaybackRecord).filter(isPresent)
      : [],
    historyEntries: historyEntries.map((entry) => ({ ...entry })),
    backendHistorySummaries: backendHistorySummaries
      .map(cloneBackendHistorySummary)
      .filter(isPresent),
    backendHistoryEntries: backendHistoryEntries
      .map(cloneBackendHistoryMessage)
      .filter(isPresent),
    activeBackendHistoryUid: normalizeText(snapshot.activeBackendHistoryUid),
    backendHistoryLoading: Boolean(snapshot.backendHistoryLoading),
    backendHistoryStatusMessage: normalizeText(snapshot.backendHistoryStatusMessage),
    runtimeSemanticAxisProfile: cloneSemanticAxisProfile(
      snapshot.runtimeSemanticAxisProfile,
    ),
    baseActionPreview: cloneBaseActionPreview(snapshot.baseActionPreview),
  };
}

function normalizeMotionTuningSamples(
  samples: unknown,
): DesktopMotionTuningSample[] {
  if (!Array.isArray(samples)) {
    return [];
  }
  return samples.map(cloneMotionTuningSample).filter(isPresent);
}

function normalizeProfileAuthoringSnapshot(
  snapshot: DesktopProfileAuthoringSnapshot,
): DesktopProfileAuthoringSnapshot {
  return {
    latestSemanticAxisProfileSaveResult: snapshot.latestSemanticAxisProfileSaveResult
      ? { ...snapshot.latestSemanticAxisProfileSaveResult }
      : null,
  };
}

function cloneMotionPlaybackRecord(
  record: unknown,
): DesktopMotionPlaybackRecord | null {
  try {
    if (!isObject(record)) {
      return null;
    }
    const plan = cloneSemanticParameterPlan(record.plan);
    if (!plan) {
      console.warn("[DesktopBridge] legacy or invalid motion playback record ignored.", {
        schemaVersion: isObject(record.plan)
          ? normalizeText(record.plan.schema_version)
          : "",
      });
      return null;
    }
    const diagnostics = isObject(record.diagnostics)
      ? {
        ...record.diagnostics,
        axisIntensityScale: isObject(record.diagnostics.axisIntensityScale)
          ? { ...record.diagnostics.axisIntensityScale }
          : {},
      }
      : null;
    return {
      ...(record as unknown as DesktopMotionPlaybackRecord),
      diagnostics: diagnostics as DesktopMotionPlaybackRecord["diagnostics"],
      plan,
    } satisfies DesktopMotionPlaybackRecord;
  } catch (error) {
    console.warn("[DesktopBridge] motion playback record rejected.", error, record);
    return null;
  }
}

function cloneBackendHistorySummary(
  summary: unknown,
): DesktopBackendHistorySummary | null {
  if (!isObject(summary)) {
    return null;
  }

  const uid = normalizeText(summary.uid);
  if (!uid) {
    return null;
  }

  const latestMessage = isObject(summary.latestMessage)
    ? cloneBackendHistorySummaryMessage(summary.latestMessage)
    : null;
  const timestamp = normalizeText(summary.timestamp)
    || latestMessage?.timestamp
    || "";

  return {
    uid,
    latestMessage,
    timestamp,
  } satisfies DesktopBackendHistorySummary;
}

function cloneBackendHistorySummaryMessage(
  message: unknown,
): DesktopBackendHistorySummary["latestMessage"] {
  if (!isObject(message)) {
    return null;
  }

  const content = normalizeText(message.content);
  const timestamp = normalizeText(message.timestamp);
  const role = normalizeBackendHistoryRole(message.role);
  if (!content && !timestamp) {
    return null;
  }

  return {
    role,
    timestamp,
    content,
  };
}

function cloneBackendHistoryMessage(
  message: unknown,
): DesktopBackendHistoryMessage | null {
  if (!isObject(message)) {
    return null;
  }

  const id = normalizeText(message.id);
  if (!id) {
    return null;
  }

  return {
    id,
    role: normalizeBackendHistoryRole(message.role),
    type: normalizeText(message.type) || "text",
    content: normalizeText(message.content),
    timestamp: normalizeText(message.timestamp),
    name: normalizeOptionalText(message.name),
    toolId: normalizeOptionalText(message.toolId),
    toolName: normalizeOptionalText(message.toolName),
    status: normalizeOptionalText(message.status),
    avatar: normalizeOptionalText(message.avatar),
  } satisfies DesktopBackendHistoryMessage;
}

function normalizeBackendHistoryRole(
  value: unknown,
): DesktopBackendHistoryMessage["role"] {
  const role = normalizeText(value).toLowerCase();
  if (role === "human" || role === "ai") {
    return role;
  }
  return "system";
}

function normalizeOptionalText(value: unknown): string | undefined {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function cloneMotionTuningSample(
  sample: unknown,
): DesktopMotionTuningSample | null {
  try {
    if (!isObject(sample)) {
      return null;
    }
    const adjustedPlan = cloneSemanticParameterPlan(sample.adjustedPlan);
    if (!adjustedPlan) {
      console.warn("[DesktopBridge] legacy or invalid motion tuning sample ignored.", {
        schemaVersion: isObject(sample.adjustedPlan)
          ? normalizeText(sample.adjustedPlan.schema_version)
          : "",
      });
      return null;
    }
    // Treat the embedded adjusted plan as the canonical identity for upgraded samples.
    const modelName = adjustedPlan.model_id;
    const profileId = adjustedPlan.profile_id;
    const profileRevision = Math.round(adjustedPlan.profile_revision);
    return {
      ...(sample as unknown as DesktopMotionTuningSample),
      modelName,
      tags: Array.isArray(sample.tags)
        ? sample.tags.map((item) => normalizeText(item)).filter(Boolean)
        : [],
      profileId,
      profileRevision,
      enabledForLlmReference: Boolean(sample.enabledForLlmReference),
      originalAxes: cloneNumericRecord(sample.originalAxes),
      adjustedAxes: cloneNumericRecord(sample.adjustedAxes),
      adjustedPlan,
    } satisfies DesktopMotionTuningSample;
  } catch (error) {
    console.warn("[DesktopBridge] motion tuning sample rejected.", error, sample);
    return null;
  }
}

function isPresent<TValue>(value: TValue | null): value is TValue {
  return value !== null;
}

function cloneNumericRecord(value: unknown): Record<string, number> {
  if (!isObject(value)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isFiniteNumber(item)) {
      result[key] = item;
    }
  }
  return result;
}

function cloneSemanticParameterPlan(plan: unknown): SemanticParameterPlan | null {
  if (!isObject(plan) || normalizeText(plan.schema_version) !== "engine.parameter_plan.v2") {
    return null;
  }
  if (!Array.isArray(plan.parameters) || !isObject(plan.timing)) {
    return null;
  }
  const profileId = normalizeText(plan.profile_id);
  const modelId = normalizeText(plan.model_id);
  const profileRevision = plan.profile_revision;
  const mode = normalizeText(plan.mode);
  const emotionLabel = normalizeText(plan.emotion_label);
  if (
    !profileId
    || !modelId
    || !isFiniteNumber(profileRevision)
    || profileRevision <= 0
    || (mode !== "idle" && mode !== "expressive")
    || !emotionLabel
  ) {
    return null;
  }
  const durationMs = plan.timing.duration_ms;
  const blendInMs = plan.timing.blend_in_ms;
  const holdMs = plan.timing.hold_ms;
  const blendOutMs = plan.timing.blend_out_ms;
  if (
    !isFiniteNumber(durationMs)
    || !isFiniteNumber(blendInMs)
    || !isFiniteNumber(holdMs)
    || !isFiniteNumber(blendOutMs)
    || durationMs < 0
    || blendInMs < 0
    || holdMs < 0
    || blendOutMs < 0
  ) {
    return null;
  }
  const parameters: SemanticParameterPlan["parameters"] = [];
  for (const item of plan.parameters) {
    if (!isObject(item)) {
      return null;
    }
    const axisId = normalizeText(item.axis_id);
    const parameterId = normalizeText(item.parameter_id);
    const targetValue = item.target_value;
    const weight = item.weight;
    if (!axisId || !parameterId || !isFiniteNumber(targetValue) || !isFiniteNumber(weight)) {
      return null;
    }
    if (weight < 0 || weight > 1) {
      return null;
    }
    const inputValue = isFiniteNumber(item.input_value) ? item.input_value : undefined;
    const source = item.source === "semantic_axis" || item.source === "coupling" || item.source === "manual"
      ? item.source
      : undefined;
    parameters.push({
      axis_id: axisId,
      parameter_id: parameterId,
      target_value: targetValue,
      weight,
      input_value: inputValue,
      source,
    });
  }
  if (!parameters.length) {
    return null;
  }

  return {
    ...plan,
    schema_version: "engine.parameter_plan.v2",
    profile_id: profileId,
    profile_revision: Math.round(profileRevision),
    model_id: modelId,
    mode,
    emotion_label: emotionLabel,
    timing: {
      duration_ms: Math.round(durationMs),
      blend_in_ms: Math.round(blendInMs),
      hold_ms: Math.round(holdMs),
      blend_out_ms: Math.round(blendOutMs),
    },
    parameters,
    diagnostics: isObject(plan.diagnostics)
      ? {
        ...plan.diagnostics,
        warnings: Array.isArray(plan.diagnostics.warnings)
          ? plan.diagnostics.warnings.map((item) => normalizeText(item)).filter(Boolean)
          : undefined,
      }
      : undefined,
    summary: isObject(plan.summary) ? { ...plan.summary } : undefined,
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
    const nextSnapshot = safeNormalizeSnapshot(snapshot, "publish") ?? defaultSnapshot;
    state.snapshot = nextSnapshot;
    persistRuntimeSnapshot(nextSnapshot);
    runtimeChannel?.postMessage({
      kind: "snapshot",
      snapshot: nextSnapshot,
    } satisfies RuntimeBridgeMessage);
  }

  function publishMotionTuningSamples(
    samples: unknown,
  ): void {
    const nextSamples = normalizeMotionTuningSamples(samples);
    state.motionTuningSamples = nextSamples;
    runtimeChannel?.postMessage({
      kind: "motion_tuning_samples",
      samples: nextSamples,
    } satisfies RuntimeBridgeMessage);
  }

  function publishProfileAuthoringSnapshot(
    snapshot: DesktopProfileAuthoringSnapshot,
  ): void {
    const nextSnapshot =
      safeNormalizeProfileAuthoringSnapshot(snapshot, "publish")
      ?? defaultProfileAuthoringSnapshot;
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
