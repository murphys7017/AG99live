import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopRuntimeSnapshot,
  DesktopMotionPlaybackRecord,
} from "../../types/desktop";
import {
  buildDefaultModelEngineSettings,
  cloneModelEngineSettings,
  normalizeModelEngineSettings,
} from "../../model-engine/settings";
import { cloneSemanticParameterPlan } from "../../model-engine/planParser";
import { DEFAULT_ADAPTER_ADDRESS } from "../../adapter-connection/core/address";
import {
  cloneNumericRecord,
  isFiniteNumber,
  isObject,
  isPresent,
  normalizeOptionalInteger,
  normalizeOptionalText,
  normalizeStringArray,
  normalizeText,
} from "../../utils/guards";

export const defaultSnapshot: DesktopRuntimeSnapshot = {
  adapterAddress: DEFAULT_ADAPTER_ADDRESS,
  desktopScreenshotOnSendEnabled: true,
  microphoneDeviceId: "",
  microphoneDevices: [],
  ambientMotionEnabled: true,
  motionEngineSettings: buildDefaultModelEngineSettings(),
  motionPlaybackRecords: [],
  connectionState: "disconnected",
  connectionLabel: "未连接",
  connectionStatusMessage: "等待桌宠窗口启动。",
  aiState: "offline",
  micRequested: false,
  micCapturing: false,
  pttModeEnabled: false,
  audioPlaying: false,
  confName: "",
  lastUpdated: "",
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
  activeSessionId: null,
  activeSessionPhase: "",
  activeSessionTextReady: false,
  activeSessionAudioTerminal: "idle",
  activeSessionMotionStarted: false,
  activeSessionMotionCompleted: false,
  activeSessionSynthFinished: false,
  activeSessionTurnFinished: false,
};

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

export function normalizeSnapshot(snapshot: DesktopRuntimeSnapshot): DesktopRuntimeSnapshot {
  rejectUnsupportedRuntimeSnapshotFields(snapshot);
  const {
    selectedModelName: _selectedModelName,
    selectedModelIconUrl: _selectedModelIconUrl,
    recommendedMode: _recommendedMode,
    runtimeSemanticAxisProfile: _runtimeSemanticAxisProfile,
    baseActionPreview: _baseActionPreview,
    ...runtimeSnapshot
  } = snapshot as DesktopRuntimeSnapshot & {
    selectedModelName?: unknown;
    selectedModelIconUrl?: unknown;
    recommendedMode?: unknown;
    runtimeSemanticAxisProfile?: unknown;
    baseActionPreview?: unknown;
  };
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
    ...runtimeSnapshot,
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
    const playbackTurnId =
      normalizeOptionalText((record as Record<string, unknown>).playbackTurnId)
      ?? normalizeOptionalText((record as Record<string, unknown>).turnId)
      ?? null;
    return {
      ...(record as unknown as DesktopMotionPlaybackRecord),
      playbackTurnId,
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
    availableDerivedAxes: normalizeStringArray(diagnostics.availableDerivedAxes),
    appliedDerivedAxes: normalizeStringArray(diagnostics.appliedDerivedAxes),
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
