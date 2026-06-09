import { cloneJson } from "../utils/cloneJson.js";
import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopHistoryEntry,
  DesktopMicrophoneDevice,
  DesktopMotionPlaybackRecord,
  DesktopPttKeyBinding,
  DesktopMotionTuningSamplesStatus,
  DesktopMotionTuningSample,
} from "../types/desktop.js";
import { cloneModelEngineSettings, type ModelEngineSettings } from "../model-engine/settings.js";
import type { TurnPlaybackSegment } from "../turn-playback/session.js";
import type { BilibiliLiveStatus } from "../types/bilibili-live.js";

// ── Adapter runtime projection ─────────────────────────────────────

export interface AdapterRuntimeProjection {
  adapterAddress: string;
  desktopScreenshotOnSendEnabled: boolean;
  microphoneDeviceId: string;
  microphoneDevices: DesktopMicrophoneDevice[];
  connectionStatusMessage: string;
  serverWsUrl: string;
  httpBaseUrl: string;
  lastAssistantText: string;
  lastTranscription: string;
  lastImageCount: number;
  currentTurnId: string | null;
  micRequested: boolean;
  micCapturing: boolean;
  pttModeEnabled: boolean;
  pttKeyBinding: DesktopPttKeyBinding;
  audioPlaying: boolean;
  historyEntries: DesktopHistoryEntry[];
  backendHistorySummaries: DesktopBackendHistorySummary[];
  backendHistoryEntries: DesktopBackendHistoryMessage[];
  activeBackendHistoryUid: string;
  backendHistoryLoading: boolean;
  backendHistoryStatusMessage: string;
  motionTuningSamples: DesktopMotionTuningSample[];
  motionTuningSamplesStatus: DesktopMotionTuningSamplesStatus;
  bilibiliLiveStatus: BilibiliLiveStatus;
}

export interface AdapterRuntimeProjectionInput {
  address: string;
  desktopScreenshotOnSendEnabled: boolean;
  microphoneDeviceId: string;
  microphoneDevices: DesktopMicrophoneDevice[];
  statusMessage: string;
  serverWsUrl: string;
  httpBaseUrl: string;
  lastAssistantText: string;
  lastTranscription: string;
  lastImageCount: number;
  currentTurnId: string | null;
  micRequested: boolean;
  micCapturing: boolean;
  pttModeEnabled: boolean;
  pttKeyBinding: DesktopPttKeyBinding;
  isPlayingAudio: boolean;
  historyEntries: DesktopHistoryEntry[];
  backendHistorySummaries: DesktopBackendHistorySummary[];
  backendHistoryEntries: DesktopBackendHistoryMessage[];
  activeBackendHistoryUid: string;
  backendHistoryLoading: boolean;
  backendHistoryStatusMessage: string;
  motionTuningSamples: DesktopMotionTuningSample[];
  motionTuningSamplesStatus: DesktopMotionTuningSamplesStatus;
  bilibiliLiveStatus: BilibiliLiveStatus;
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
  adapter: AdapterRuntimeProjection;
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
  microphoneDeviceId: string;
  microphoneDevices: DesktopMicrophoneDevice[];
  ambientMotionEnabled: boolean;
  motionEngineSettings: ModelEngineSettings;
  motionPlaybackRecords: DesktopMotionPlaybackRecord[];
  connectionState: string;
  connectionLabel: string;
  connectionStatusMessage: string;
  aiState: string;
  micRequested: boolean;
  micCapturing: boolean;
  pttModeEnabled: boolean;
  pttKeyBinding: DesktopPttKeyBinding;
  audioPlaying: boolean;
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
  bilibiliLiveStatus: BilibiliLiveStatus;
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
    microphoneDeviceId: input.microphoneDeviceId,
    microphoneDevices: input.microphoneDevices.map((device) => ({ ...device })),
    connectionStatusMessage: input.statusMessage,
    serverWsUrl: input.serverWsUrl,
    httpBaseUrl: input.httpBaseUrl,
    lastAssistantText: input.lastAssistantText,
    lastTranscription: input.lastTranscription,
    lastImageCount: input.lastImageCount,
    currentTurnId: input.currentTurnId,
    micRequested: input.micRequested,
    micCapturing: input.micCapturing,
    audioPlaying: input.isPlayingAudio,
    pttModeEnabled: input.pttModeEnabled,
    pttKeyBinding: { ...input.pttKeyBinding },
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
    bilibiliLiveStatus: { ...input.bilibiliLiveStatus },
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
  const p = input.adapter;
  const lastSent = p.historyEntries
    .slice()
    .reverse()
    .find((entry) => entry.role === "user")?.text ?? "";

  return {
    adapterAddress: p.adapterAddress,
    desktopScreenshotOnSendEnabled: p.desktopScreenshotOnSendEnabled,
    microphoneDeviceId: p.microphoneDeviceId,
    microphoneDevices: p.microphoneDevices.map((device) => ({ ...device })),
    ambientMotionEnabled: input.ambientMotionEnabled,
    motionEngineSettings: cloneModelEngineSettings(input.motionEngineSettings),
    motionPlaybackRecords: input.motionPlaybackRecords.map((r) =>
      cloneJson(r),
    ),
    connectionState: input.connectionState,
    connectionLabel: input.connectionLabel,
    connectionStatusMessage: p.connectionStatusMessage,
    aiState: input.aiState,
    micRequested: p.micRequested,
    micCapturing: p.micCapturing,
    audioPlaying: p.audioPlaying,
    pttModeEnabled: p.pttModeEnabled,
    pttKeyBinding: { ...p.pttKeyBinding },
    confName: input.confName,
    lastUpdated: input.lastUpdated,
    serverWsUrl: p.serverWsUrl,
    httpBaseUrl: p.httpBaseUrl,
    stageMessage: input.stageMessage,
    lastSentText: lastSent,
    lastAssistantText: p.lastAssistantText,
    lastTranscription: p.lastTranscription,
    lastImageCount: p.lastImageCount,
    historyEntries: [...p.historyEntries],
    backendHistorySummaries: p.backendHistorySummaries.map((s: DesktopBackendHistorySummary) =>
      cloneJson(s),
    ),
    backendHistoryEntries: p.backendHistoryEntries.map((e: DesktopBackendHistoryMessage) =>
      cloneJson(e),
    ),
    activeBackendHistoryUid: p.activeBackendHistoryUid,
    backendHistoryLoading: p.backendHistoryLoading,
    backendHistoryStatusMessage: p.backendHistoryStatusMessage,
    bilibiliLiveStatus: { ...p.bilibiliLiveStatus },
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
