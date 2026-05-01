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
import { parseSemanticParameterPlan} from "../model-engine/planParser";
import type { SemanticAxisProfile } from "../types/semantic-axis-profile";
import {
  buildDefaultModelEngineSettings,
  cloneModelEngineSettings,
  normalizeModelEngineSettings,
} from "../model-engine/settings";
import { DEFAULT_ADAPTER_ADDRESS } from "../adapter-connection/address";
import { isFiniteNumber, isObject, normalizeText } from "../utils/guards";

export const defaultSnapshot: DesktopRuntimeSnapshot = {
  adapterAddress: DEFAULT_ADAPTER_ADDRESS,
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
  rejectUnsupportedRuntimeSnapshotFields(snapshot);
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
    ...snapshot,
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

function rejectUnsupportedRuntimeSnapshotFields(snapshot: DesktopRuntimeSnapshot): void {
  const unsupportedFields = [
    "selectedSemanticAxisProfile",
    "latestSemanticAxisProfileSaveResult",
    "motionTuningSamples",
  ].filter((field) => field in (snapshot as unknown as Record<string, unknown>));
  if (unsupportedFields.length) {
    throw new Error(
      `unsupported_runtime_snapshot_fields:${unsupportedFields.join(",")}`,
    );
  }
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

function cloneMotionPlaybackRecord(
  record: unknown,
): DesktopMotionPlaybackRecord | null {
  try {
    if (!isObject(record)) {
      return null;
    }
    const plan = cloneSemanticParameterPlan(record.plan);
    if (!plan) {
      console.warn("[DesktopBridge] invalid motion playback record ignored.", {
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
  return 0;
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
      console.warn("[DesktopBridge] invalid motion tuning sample ignored.", {
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
  const result = parseSemanticParameterPlan(plan);
  if (!result.ok) {
    return null;
  }
  const parsed = result.value;
  const planObj = plan as Record<string, unknown>;
  return {
    ...planObj,
    schema_version: parsed.schema_version,
    profile_id: parsed.profile_id,
    profile_revision: parsed.profile_revision,
    model_id: parsed.model_id,
    mode: parsed.mode,
    emotion_label: parsed.emotion_label,
    timing: parsed.timing,
    parameters: parsed.parameters,
    diagnostics: isObject(planObj.diagnostics)
      ? { ...planObj.diagnostics, warnings: parsed.diagnostics?.warnings }
      : parsed.diagnostics,
    summary: isObject(planObj.summary)
      ? { ...planObj.summary, ...parsed.summary }
      : parsed.summary,
  } as SemanticParameterPlan;
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
