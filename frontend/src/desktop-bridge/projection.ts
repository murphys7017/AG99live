import { cloneJson } from "../utils/cloneJson.js";
import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopHistoryEntry,
  DesktopMotionPlaybackRecord,
  DesktopMotionTuningSamplesStatus,
  DesktopMotionTuningSample,
} from "../types/desktop.js";
import { cloneModelEngineSettings, type ModelEngineSettings } from "../model-engine/settings.js";
import type { TurnPlaybackSegment } from "../turn-playback/session.js";

// ── Adapter runtime projection ─────────────────────────────────────

export interface AdapterRuntimeProjection {
  adapterAddress: string;
  desktopScreenshotOnSendEnabled: boolean;
  connectionStatusMessage: string;
  sessionId: string;
  serverWsUrl: string;
  httpBaseUrl: string;
  lastAssistantText: string;
  lastTranscription: string;
  lastImageCount: number;
  currentTurnId: string | null;
  micRequested: boolean;
  micCapturing: boolean;
  audioPlaying: boolean;
  historyEntries: DesktopHistoryEntry[];
  backendHistorySummaries: DesktopBackendHistorySummary[];
  backendHistoryEntries: DesktopBackendHistoryMessage[];
  activeBackendHistoryUid: string;
  backendHistoryLoading: boolean;
  backendHistoryStatusMessage: string;
  motionTuningSamples: DesktopMotionTuningSample[];
  motionTuningSamplesStatus: DesktopMotionTuningSamplesStatus;
}

export interface AdapterRuntimeProjectionInput {
  address: string;
  desktopScreenshotOnSendEnabled: boolean;
  statusMessage: string;
  sessionId: string;
  serverWsUrl: string;
  httpBaseUrl: string;
  lastAssistantText: string;
  lastTranscription: string;
  lastImageCount: number;
  currentTurnId: string | null;
  micRequested: boolean;
  micCapturing: boolean;
  isPlayingAudio: boolean;
  historyEntries: DesktopHistoryEntry[];
  backendHistorySummaries: DesktopBackendHistorySummary[];
  backendHistoryEntries: DesktopBackendHistoryMessage[];
  activeBackendHistoryUid: string;
  backendHistoryLoading: boolean;
  backendHistoryStatusMessage: string;
  motionTuningSamples: DesktopMotionTuningSample[];
  motionTuningSamplesStatus: DesktopMotionTuningSamplesStatus;
}

export interface SessionProjectionInput {
  activeSessionId: string | null;
  activeSessionPhase: string;
  activeSessionTextReady: boolean;
  activeSessionAudioTerminal: string;
  activeSessionMotionStarted: boolean;
  activeSessionMotionCompleted: boolean;
  activeSessionSynthFinished: boolean;
  activeSessionTurnFinished: boolean;
}

export interface DesktopRuntimeSnapshotInput {
  adapter: AdapterRuntimeProjectionInput;
  session: SessionProjectionInput;
  ambientMotionEnabled: boolean;
  motionEngineSettings: ModelEngineSettings;
  motionPlaybackRecords: readonly DesktopMotionPlaybackRecord[];
  connectionState: string;
  connectionLabel: string;
  stageMessage: string;
  aiState: string;
  confName: string;
  lastUpdated: string;
}

export interface DesktopRuntimeSnapshotOutput {
  adapterAddress: string;
  desktopScreenshotOnSendEnabled: boolean;
  ambientMotionEnabled: boolean;
  motionEngineSettings: ModelEngineSettings;
  motionPlaybackRecords: DesktopMotionPlaybackRecord[];
  connectionState: string;
  connectionLabel: string;
  connectionStatusMessage: string;
  aiState: string;
  micRequested: boolean;
  micCapturing: boolean;
  audioPlaying: boolean;
  sessionId: string;
  confName: string;
  lastUpdated: string;
  serverWsUrl: string;
  httpBaseUrl: string;
  stageMessage: string;
  lastSentText: string;
  lastAssistantText: string;
  lastTranscription: string;
  lastImageCount: number;
  historyEntries: DesktopHistoryEntry[];
  backendHistorySummaries: DesktopBackendHistorySummary[];
  backendHistoryEntries: DesktopBackendHistoryMessage[];
  activeBackendHistoryUid: string;
  backendHistoryLoading: boolean;
  backendHistoryStatusMessage: string;
  activeSessionId: string | null;
  activeSessionPhase: string;
  activeSessionTextReady: boolean;
  activeSessionAudioTerminal: string;
  activeSessionMotionStarted: boolean;
  activeSessionMotionCompleted: boolean;
  activeSessionSynthFinished: boolean;
  activeSessionTurnFinished: boolean;
}

// ── Builders ───────────────────────────────────────────────────────

export function buildAdapterRuntimeProjection(
  input: AdapterRuntimeProjectionInput,
): AdapterRuntimeProjection {
  return {
    adapterAddress: input.address,
    desktopScreenshotOnSendEnabled: input.desktopScreenshotOnSendEnabled,
    connectionStatusMessage: input.statusMessage,
    sessionId: input.sessionId,
    serverWsUrl: input.serverWsUrl,
    httpBaseUrl: input.httpBaseUrl,
    lastAssistantText: input.lastAssistantText,
    lastTranscription: input.lastTranscription,
    lastImageCount: input.lastImageCount,
    currentTurnId: input.currentTurnId,
    micRequested: input.micRequested,
    micCapturing: input.micCapturing,
    audioPlaying: input.isPlayingAudio,
    historyEntries: [...input.historyEntries],
    backendHistorySummaries: input.backendHistorySummaries.map((s) =>
      cloneJson(s),
    ),
    backendHistoryEntries: input.backendHistoryEntries.map((e) =>
      cloneJson(e),
    ),
    activeBackendHistoryUid: input.activeBackendHistoryUid,
    backendHistoryLoading: input.backendHistoryLoading,
    backendHistoryStatusMessage: input.backendHistoryStatusMessage,
    motionTuningSamples: input.motionTuningSamples,
    motionTuningSamplesStatus: input.motionTuningSamplesStatus,
  };
}

export function getActiveSegmentSnapshot(
  activeSession: {
    segmentOrder: string[];
    segments: Map<string, TurnPlaybackSegment>;
  } | undefined,
): {
  textReady: boolean;
  audioTerminal: string;
  motionStarted: boolean;
  motionCompleted: boolean;
} | null {
  if (!activeSession) {
    return null;
  }

  // Find first non-settled segment
  for (const segmentId of activeSession.segmentOrder) {
    const segment = activeSession.segments.get(segmentId);
    if (segment && !isLocallySettled(segment)) {
      return {
        textReady: segment.text.content !== null,
        audioTerminal: segment.audio.terminal,
        motionStarted: segment.motion.started,
        motionCompleted: segment.motion.completed,
      };
    }
  }

  // fallback: first segment
  const firstSegment = activeSession.segmentOrder
    .map((id) => activeSession.segments.get(id))
    .find(Boolean);
  return firstSegment
    ? {
        textReady: firstSegment.text.content !== null,
        audioTerminal: firstSegment.audio.terminal,
        motionStarted: firstSegment.motion.started,
        motionCompleted: firstSegment.motion.completed,
      }
    : null;
}

function isLocallySettled(segment: TurnPlaybackSegment): boolean {
  if (!segment.text.delivered) return false;
  const t = segment.audio.terminal;
  if (t !== "completed" && t !== "failed" && t !== "absent") return false;
  if (!segment.motion.absent && !segment.motion.completed) return false;
  return true;
}

export function buildDesktopRuntimeSnapshot(
  input: DesktopRuntimeSnapshotInput,
): DesktopRuntimeSnapshotOutput {
  const history = input.adapter.historyEntries;
  const lastSent = history
    .slice()
    .reverse()
    .find((entry) => entry.role === "user")?.text ?? "";

  return {
    adapterAddress: input.adapter.address,
    desktopScreenshotOnSendEnabled: input.adapter.desktopScreenshotOnSendEnabled,
    ambientMotionEnabled: input.ambientMotionEnabled,
    motionEngineSettings: cloneModelEngineSettings(input.motionEngineSettings),
    motionPlaybackRecords: input.motionPlaybackRecords.map((r) =>
      cloneJson(r),
    ),
    connectionState: input.connectionState,
    connectionLabel: input.connectionLabel,
    connectionStatusMessage: input.adapter.statusMessage,
    aiState: input.aiState,
    micRequested: input.adapter.micRequested,
    micCapturing: input.adapter.micCapturing,
    audioPlaying: input.adapter.isPlayingAudio,
    sessionId: input.adapter.sessionId,
    confName: input.confName,
    lastUpdated: input.lastUpdated,
    serverWsUrl: input.adapter.serverWsUrl,
    httpBaseUrl: input.adapter.httpBaseUrl,
    stageMessage: input.stageMessage,
    lastSentText: lastSent,
    lastAssistantText: input.adapter.lastAssistantText,
    lastTranscription: input.adapter.lastTranscription,
    lastImageCount: input.adapter.lastImageCount,
    historyEntries: [...input.adapter.historyEntries],
    backendHistorySummaries: input.adapter.backendHistorySummaries.map((s) =>
      cloneJson(s),
    ),
    backendHistoryEntries: input.adapter.backendHistoryEntries.map((e) =>
      cloneJson(e),
    ),
    activeBackendHistoryUid: input.adapter.activeBackendHistoryUid,
    backendHistoryLoading: input.adapter.backendHistoryLoading,
    backendHistoryStatusMessage: input.adapter.backendHistoryStatusMessage,
    activeSessionId: input.session.activeSessionId,
    activeSessionPhase: input.session.activeSessionPhase,
    activeSessionTextReady: input.session.activeSessionTextReady,
    activeSessionAudioTerminal: input.session.activeSessionAudioTerminal,
    activeSessionMotionStarted: input.session.activeSessionMotionStarted,
    activeSessionMotionCompleted: input.session.activeSessionMotionCompleted,
    activeSessionSynthFinished: input.session.activeSessionSynthFinished,
    activeSessionTurnFinished: input.session.activeSessionTurnFinished,
  };
}
