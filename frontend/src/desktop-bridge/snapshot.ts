import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopBaseActionPreview,
  DesktopMotionPlaybackRecord,
  DesktopMotionTuningSample,
  DesktopMotionTuningSamplesStatus,
  DesktopProfileAuthoringSnapshot,
  DesktopRuntimeSnapshot,
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

export const defaultSnapshot: DesktopRuntimeSnapshot = {
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

export const defaultProfileAuthoringSnapshot: DesktopProfileAuthoringSnapshot = {
  latestSemanticAxisProfileSaveResult: null,
};

export function normalizeMotionTuningSamplesStatus(
  value: unknown,
): DesktopMotionTuningSamplesStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      rootError: "",
      loadError: "",
      diagnostics: [],
    };
  }
  const candidate = value as {
    rootError?: unknown;
    loadError?: unknown;
    diagnostics?: unknown;
  };
  return {
    rootError: normalizeText(candidate.rootError),
    loadError: normalizeText(candidate.loadError),
    diagnostics: Array.isArray(candidate.diagnostics)
      ? candidate.diagnostics.map((item) => normalizeText(item)).filter(Boolean)
      : [],
  };
}

export function safeNormalizeSnapshot(
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

export function safeNormalizeProfileAuthoringSnapshot(
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

export function normalizeSnapshot(snapshot: DesktopRuntimeSnapshot): DesktopRuntimeSnapshot {
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

export function normalizeMotionTuningSamples(
  samples: unknown,
): DesktopMotionTuningSample[] {
  if (!Array.isArray(samples)) {
    return [];
  }
  return samples.map(cloneMotionTuningSample).filter(isPresent);
}

export function normalizeProfileAuthoringSnapshot(
  snapshot: DesktopProfileAuthoringSnapshot,
): DesktopProfileAuthoringSnapshot {
  return {
    latestSemanticAxisProfileSaveResult: snapshot.latestSemanticAxisProfileSaveResult
      ? { ...snapshot.latestSemanticAxisProfileSaveResult }
      : null,
  };
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
    const diagnostics = cloneMotionCompileDiagnostics(record.diagnostics);
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

function cloneMotionCompileDiagnostics(
  diagnostics: unknown,
): DesktopMotionPlaybackRecord["diagnostics"] {
  if (!isObject(diagnostics)) {
    return null;
  }
  const compiledParameterCount = normalizeCompiledParameterCount(diagnostics);
  return {
    usedActionLibrary: Boolean(diagnostics.usedActionLibrary),
    compiledParameterCount,
    timingSource: normalizeTimingSource(diagnostics.timingSource),
    resolvedMode: normalizeMotionMode(diagnostics.resolvedMode),
    source: normalizeOptionalText(diagnostics.source),
    warnings: normalizeStringArray(diagnostics.warnings),
    primaryAxes: normalizeStringArray(diagnostics.primaryAxes),
    hintAxes: normalizeStringArray(diagnostics.hintAxes),
    derivedAxes: normalizeStringArray(diagnostics.derivedAxes),
    runtimeAxes: normalizeStringArray(diagnostics.runtimeAxes),
    missingAxes: normalizeStringArray(diagnostics.missingAxes),
    forbiddenAxes: normalizeStringArray(diagnostics.forbiddenAxes),
    invalidAxes: normalizeStringArray(diagnostics.invalidAxes),
    axisErrorCount: normalizeOptionalInteger(diagnostics.axisErrorCount),
    axisErrorLimit: normalizeOptionalInteger(diagnostics.axisErrorLimit),
    compiledParameters: normalizeStringArray(diagnostics.compiledParameters),
    intensityApplied: Boolean(diagnostics.intensityApplied),
    motionIntensityScale: isFiniteNumber(diagnostics.motionIntensityScale)
      ? diagnostics.motionIntensityScale
      : 1,
    axisIntensityScale: cloneNumericRecord(diagnostics.axisIntensityScale),
  };
}

function normalizeCompiledParameterCount(
  diagnostics: Record<string, unknown>,
): number {
  if (isFiniteNumber(diagnostics.compiledParameterCount)) {
    return Math.max(0, Math.round(diagnostics.compiledParameterCount));
  }
  // Legacy snapshots used supplementaryCount before ModelEngine stopped using action-library fallback.
  const legacySupplementaryCount = Number(diagnostics.supplementaryCount ?? 0);
  return Number.isFinite(legacySupplementaryCount)
    ? Math.max(0, Math.round(legacySupplementaryCount))
    : 0;
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

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.map((item) => normalizeText(item)).filter(Boolean);
  return normalized.length ? normalized : undefined;
}

function normalizeOptionalInteger(value: unknown): number | undefined {
  if (!isFiniteNumber(value)) {
    return undefined;
  }
  return Math.max(0, Math.round(value));
}

function normalizeTimingSource(
  value: unknown,
): NonNullable<DesktopMotionPlaybackRecord["diagnostics"]>["timingSource"] {
  const normalized = normalizeText(value);
  if (normalized === "hint" || normalized === "audio_sync") {
    return normalized;
  }
  return "default";
}

function normalizeMotionMode(value: unknown): DesktopMotionPlaybackRecord["mode"] {
  const normalized = normalizeText(value);
  if (normalized === "expressive") {
    return "expressive";
  }
  return "idle";
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
