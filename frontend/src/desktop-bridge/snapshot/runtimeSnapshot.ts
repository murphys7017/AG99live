import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopRuntimeSnapshot,
  DesktopMotionPlaybackRecord,
  DesktopPttHookStatus,
} from "../../types/desktop.js";
import type { CatalogMotionPayload } from "../../types/protocol.js";
import {
  buildDefaultModelEngineSettings,
  cloneModelEngineSettings,
  normalizeModelEngineSettings,
} from "../../model-engine/settings.js";
import {
  buildDefaultLive2dPresentationSettings,
  cloneLive2dPresentationSettings,
} from "../../live2d-renderer/settings.js";
import { cloneSemanticParameterPlan } from "../../model-engine/planParser.js";
import { cloneCompiledSemanticMotion } from "../../model-engine/compiler/compiledSemanticMotionParser.js";
import { PERFORMANCE_SCHEDULE_TRACE_VERSION } from "../../types/compiledSemanticMotion.js";
import { DEFAULT_ADAPTER_ADDRESS } from "../../adapter-connection/core/address.js";
import {
  DEFAULT_PTT_KEY_BINDING,
  normalizePttKeyBinding,
} from "../../adapter-connection/core/pttKeyBinding.js";
import {
  DEFAULT_BILIBILI_LIVE_STATUS,
  type BilibiliLiveStatus,
} from "../../types/bilibili-live.js";
import { SCHEMA_CATALOG_MOTION_V1 } from "../../types/protocol.js";
import { cloneJson } from "../../utils/cloneJson.js";
import {
  isFiniteNumber,
  isObject,
  isPresent,
  normalizeOptionalInteger,
  normalizeOptionalText,
  normalizeStringArray,
  normalizeText,
} from "../../utils/guards.js";

function generatePublisherId(): string {
  return `pub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const globalPublisherId = generatePublisherId();
let globalRevision = 0;

export function nextSnapshotRevision(): number {
  globalRevision += 1;
  return globalRevision;
}

export function getPublisherId(): string {
  return globalPublisherId;
}

export const defaultSnapshot: DesktopRuntimeSnapshot = {
  _publisherId: getPublisherId(),
  _revision: nextSnapshotRevision(),
  adapterAddress: DEFAULT_ADAPTER_ADDRESS,
  desktopScreenshotOnSendEnabled: true,
  microphoneDeviceId: "",
  microphoneDevices: [],
  motionEngineSettings: buildDefaultModelEngineSettings(),
  live2dPresentationSettings: buildDefaultLive2dPresentationSettings(),
  motionPlaybackRecords: [],
  connectionState: "disconnected",
  connectionLabel: "未连接",
  connectionStatusMessage: "等待桌宠窗口启动。",
  aiState: "offline",
  micRequested: false,
  micCapturing: false,
  pttModeEnabled: false,
  pttKeyBinding: DEFAULT_PTT_KEY_BINDING,
  pttHookStatus: {
    available: true,
    enabled: false,
    keycode: null,
    reason: "",
    updatedAt: "",
  },
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
  bilibiliLiveStatus: { ...DEFAULT_BILIBILI_LIVE_STATUS },
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
  if (typeof snapshot._publisherId !== "string" || !snapshot._publisherId.trim()) {
    throw new Error("runtime_snapshot_publisher_id_missing");
  }
  if (!Number.isInteger(snapshot._revision) || snapshot._revision < 0) {
    throw new Error("runtime_snapshot_revision_invalid");
  }
  const {
    selectedModelName: _selectedModelName,
    selectedModelIconUrl: _selectedModelIconUrl,
    recommendedMode: _recommendedMode,
    runtimeSemanticAxisProfile: _runtimeSemanticAxisProfile,
    baseActionPreview: _baseActionPreview,
    activeSessionId: _activeSessionId,
    activeSessionPhase: _activeSessionPhase,
    activeSessionTextReady: _activeSessionTextReady,
    activeSessionAudioTerminal: _activeSessionAudioTerminal,
    activeSessionMotionStarted: _activeSessionMotionStarted,
    activeSessionMotionCompleted: _activeSessionMotionCompleted,
    activeSessionSynthFinished: _activeSessionSynthFinished,
    activeSessionTurnFinished: _activeSessionTurnFinished,
    ...runtimeSnapshot
  } = snapshot as DesktopRuntimeSnapshot & {
    selectedModelName?: unknown;
    selectedModelIconUrl?: unknown;
    recommendedMode?: unknown;
    runtimeSemanticAxisProfile?: unknown;
    baseActionPreview?: unknown;
    activeSessionId?: unknown;
    activeSessionPhase?: unknown;
    activeSessionTextReady?: unknown;
    activeSessionAudioTerminal?: unknown;
    activeSessionMotionStarted?: unknown;
    activeSessionMotionCompleted?: unknown;
    activeSessionSynthFinished?: unknown;
    activeSessionTurnFinished?: unknown;
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
    _publisherId: snapshot._publisherId.trim(),
    _revision: snapshot._revision,
    motionEngineSettings: cloneModelEngineSettings(
      normalizeModelEngineSettings(snapshot.motionEngineSettings),
    ),
    live2dPresentationSettings: cloneLive2dPresentationSettings(
      snapshot.live2dPresentationSettings,
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
    pttKeyBinding: normalizePttKeyBinding(snapshot.pttKeyBinding),
    activeBackendHistoryUid: normalizeText(snapshot.activeBackendHistoryUid),
    backendHistoryLoading: Boolean(snapshot.backendHistoryLoading),
    backendHistoryStatusMessage: normalizeText(snapshot.backendHistoryStatusMessage),
    bilibiliLiveStatus: normalizeBilibiliLiveStatus(snapshot.bilibiliLiveStatus),
    pttHookStatus: normalizePttHookStatus(snapshot.pttHookStatus),
  };
}

function normalizePttHookStatus(value: unknown): DesktopPttHookStatus {
  if (!isObject(value)) {
    return { ...defaultSnapshot.pttHookStatus };
  }
  return {
    available: Boolean(value.available),
    enabled: Boolean(value.enabled),
    keycode: isFiniteNumber(value.keycode) ? Math.round(value.keycode) : null,
    reason: normalizeText(value.reason),
    updatedAt: normalizeText(value.updatedAt),
  };
}

function normalizeBilibiliLiveStatus(value: unknown): BilibiliLiveStatus {
  if (!isObject(value)) {
    return { ...DEFAULT_BILIBILI_LIVE_STATUS };
  }
  return {
    enabled: Boolean(value.enabled),
    connected: Boolean(value.connected),
    status: normalizeBilibiliLiveStatusKind(value.status),
    roomId: normalizeText(value.roomId),
    realRoomId: isFiniteNumber(value.realRoomId) ? Math.round(value.realRoomId) : null,
    bufferedCount: isFiniteNumber(value.bufferedCount)
      ? Math.max(0, Math.round(value.bufferedCount))
      : 0,
    authReceived: Boolean(value.authReceived),
    heartbeatReceived: Boolean(value.heartbeatReceived),
    commandCount: isFiniteNumber(value.commandCount)
      ? Math.max(0, Math.round(value.commandCount))
      : 0,
    danmakuCount: isFiniteNumber(value.danmakuCount)
      ? Math.max(0, Math.round(value.danmakuCount))
      : 0,
    lastCommand: normalizeText(value.lastCommand),
    protover: isFiniteNumber(value.protover) ? Math.round(value.protover) : null,
    lastMessageAt: normalizeText(value.lastMessageAt),
    lastError: normalizeText(value.lastError),
    hasCookie: Boolean(value.hasCookie),
  };
}

function normalizeBilibiliLiveStatusKind(
  value: unknown,
): BilibiliLiveStatus["status"] {
  const normalized = normalizeText(value);
  if (
    normalized === "idle"
    || normalized === "connecting"
    || normalized === "connected"
    || normalized === "error"
  ) {
    return normalized;
  }
  return "disabled";
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
    if (!hasCompatiblePerformanceScheduleTrace(record.diagnostics)) {
      console.warn("[DesktopBridge] incompatible performance schedule trace discarded.", {
        version: resolvePerformanceScheduleTraceVersion(record.diagnostics),
      });
      return null;
    }
    const diagnostics = cloneMotionCompileDiagnostics(record.diagnostics);
    const playbackTurnId =
      normalizeOptionalText((record as Record<string, unknown>).playbackTurnId)
      ?? normalizeOptionalText((record as Record<string, unknown>).turnId)
      ?? null;
    const payloadKind = normalizeText(record.payloadKind);
    if (payloadKind === "catalog_motion" || payloadKind === "semantic_motion_resource") {
      const motion = cloneCatalogMotionPayload(record.motion);
      if (!motion) {
        console.warn("[DesktopBridge] invalid catalog motion playback record ignored.", {
          schemaVersion: isObject(record.motion)
            ? normalizeText(record.motion.schema_version)
            : "",
        });
        return null;
      }
      return {
        ...(record as unknown as DesktopMotionPlaybackRecord),
        payloadKind,
        messageId: normalizeText(record.messageId),
        playbackTurnId,
        emotionLabel: normalizeText(record.emotionLabel) || motion.emotion_label || motion.label || motion.motion_id,
        mode: payloadKind === "semantic_motion_resource" && record.mode === "idle"
          ? "idle"
          : "expressive",
        diagnostics: diagnostics as DesktopMotionPlaybackRecord["diagnostics"],
        motion,
        plan: null,
      } satisfies DesktopMotionPlaybackRecord;
    }
    if (
      payloadKind !== "semantic_intent"
      && payloadKind !== "speech_only"
    ) {
      console.warn("[DesktopBridge] unknown motion playback payload kind ignored.", {
        payloadKind,
      });
      return null;
    }
    const plan = cloneSemanticParameterPlan(record.plan);
    const semanticMotion = cloneCompiledSemanticMotion(record.semanticMotion);
    if (!plan || !semanticMotion) {
      console.warn("[DesktopBridge] invalid motion playback record ignored.", {
        schemaVersion: isObject(record.plan)
          ? normalizeText(record.plan.schema_version)
          : "",
      });
      return null;
    }
    return {
      ...(record as unknown as DesktopMotionPlaybackRecord),
      payloadKind,
      messageId: normalizeText(record.messageId),
      playbackTurnId,
      emotionLabel: normalizeText(record.emotionLabel) || plan.emotion_label,
      mode: plan.mode,
      diagnostics: diagnostics as DesktopMotionPlaybackRecord["diagnostics"],
      plan,
      semanticMotion,
      motion: null,
    } satisfies DesktopMotionPlaybackRecord;
  } catch (error) {
    console.warn("[DesktopBridge] motion playback record rejected.", error, record);
    return null;
  }
}

function cloneCatalogMotionPayload(payload: unknown): CatalogMotionPayload | null {
  if (!isObject(payload) || normalizeText(payload.schema_version) !== SCHEMA_CATALOG_MOTION_V1) {
    return null;
  }
  const modelId = normalizeText(payload.model_id);
  const motionId = normalizeText(payload.motion_id);
  const group = normalizeText(payload.group);
  const file = normalizeText(payload.file);
  const index = normalizeRequiredInteger(payload.index);
  const priority = normalizeRequiredInteger(payload.priority);
  if (!modelId || !motionId || !group || !file || index === null || priority === null) {
    return null;
  }
  return {
    schema_version: SCHEMA_CATALOG_MOTION_V1,
    model_id: modelId,
    motion_id: motionId,
    group,
    index,
    file,
    label: normalizeText(payload.label),
    emotion_label: normalizeText(payload.emotion_label),
    duration_ms: normalizeNullableInteger(payload.duration_ms),
    priority,
    summary: isObject(payload.summary)
      ? { source: normalizeOptionalText(payload.summary.source) ?? undefined }
      : undefined,
  };
}

function normalizeRequiredInteger(value: unknown): number | null {
  if (!isFiniteNumber(value)) {
    return null;
  }
  return Math.max(0, Math.round(value));
}

function normalizeNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isFiniteNumber(value)) {
    return null;
  }
  return Math.max(0, Math.round(value));
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
    activeGroups: normalizeStringArray(diagnostics.activeGroups),
    skeletonGroups: normalizeStringArray(diagnostics.skeletonGroups),
    missingSkeletonGroups: normalizeStringArray(diagnostics.missingSkeletonGroups),
    maxDeltaFromNeutral: isFiniteNumber(diagnostics.maxDeltaFromNeutral)
      ? diagnostics.maxDeltaFromNeutral
      : undefined,
    neutralishAxisCount: normalizeOptionalInteger(diagnostics.neutralishAxisCount),
    expressiveAxisCount: normalizeOptionalInteger(diagnostics.expressiveAxisCount),
    semanticAxisCount: normalizeOptionalInteger(diagnostics.semanticAxisCount),
    failureStage: normalizeOptionalText(diagnostics.failureStage),
    relationSkippedExplicitTargets: normalizeStringArray(diagnostics.relationSkippedExplicitTargets),
    transformTrace: isObject(diagnostics.transformTrace)
      ? cloneJson(diagnostics.transformTrace) as NonNullable<
          DesktopMotionPlaybackRecord["diagnostics"]
        >["transformTrace"]
      : undefined,
  };
}

function hasCompatiblePerformanceScheduleTrace(diagnostics: unknown): boolean {
  if (!isObject(diagnostics) || !isObject(diagnostics.transformTrace)) {
    return true;
  }
  const schedule = diagnostics.transformTrace.performanceSchedule;
  if (schedule === undefined) {
    return true;
  }
  if (!isObject(schedule) || schedule.version !== PERFORMANCE_SCHEDULE_TRACE_VERSION) {
    return false;
  }
  return Array.isArray(schedule.phrases)
    && Array.isArray(schedule.semanticSteps)
    && Array.isArray(schedule.estimatedAlignments)
    && Array.isArray(schedule.events)
    && schedule.events.every(isCompatiblePerformanceEvent)
    && Array.isArray(schedule.parameterNodes)
    && schedule.parameterNodes.every(isCompatiblePerformanceNode);
}

// The producer owns full trace semantics. This boundary only rejects records
// that cannot be safely rendered by Motion Lab.
function isCompatiblePerformanceEvent(event: unknown): boolean {
  return isObject(event)
    && typeof event.id === "string"
    && Boolean(event.id.trim())
    && (
      event.kind === "semantic_transition"
      || event.kind === "speech_start"
      || event.kind === "speech_phrase"
      || event.kind === "speech_release"
      || event.kind === "gaze_lead"
      || event.kind === "gaze_dwell"
      || event.kind === "gaze_transfer"
      || event.kind === "gaze_release"
    )
    && typeof event.semanticAxisId === "string"
    && Boolean(event.semanticAxisId.trim())
    && isFiniteNumber(event.atMs)
    && isFiniteNumber(event.transitionMs)
    && (event.localAtMs === undefined || isFiniteNumber(event.localAtMs))
    && (event.stepIndex === undefined || Number.isInteger(event.stepIndex))
    && (
      event.phraseIndices === undefined
      || (
        Array.isArray(event.phraseIndices)
        && event.phraseIndices.every((index) => Number.isInteger(index))
      )
    );
}

function isCompatiblePerformanceNode(node: unknown): boolean {
  return isObject(node)
    && typeof node.parameterId === "string"
    && Boolean(node.parameterId.trim())
    && (node.trackKind === "keyframe" || node.trackKind === "speech_modulation")
    && Number.isInteger(node.nodeIndex)
    && typeof node.eventId === "string"
    && Boolean(node.eventId.trim());
}

function resolvePerformanceScheduleTraceVersion(diagnostics: unknown): string {
  if (!isObject(diagnostics) || !isObject(diagnostics.transformTrace)) {
    return "missing";
  }
  const schedule = diagnostics.transformTrace.performanceSchedule;
  return isObject(schedule) ? normalizeText(schedule.version) || "missing" : "invalid";
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
