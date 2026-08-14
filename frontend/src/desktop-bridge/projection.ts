import { cloneJson } from "../utils/cloneJson.js";
import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopHistoryEntry,
  DesktopMicrophoneDevice,
  DesktopMotionPlaybackRecord,
  DesktopPttHookStatus,
  DesktopPttKeyBinding,
} from "../types/desktop.js";
import { cloneModelEngineSettings, type ModelEngineSettings } from "../model-engine/settings.js";
import {
  cloneLive2dPresentationSettings,
  type Live2dPresentationSettings,
} from "../live2d-renderer/settings.js";
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
  pttHookStatus: DesktopPttHookStatus;
  audioPlaying: boolean;
  historyEntries: DesktopHistoryEntry[];
  backendHistorySummaries: DesktopBackendHistorySummary[];
  backendHistoryEntries: DesktopBackendHistoryMessage[];
  activeBackendHistoryUid: string;
  backendHistoryLoading: boolean;
  backendHistoryStatusMessage: string;
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
  pttHookStatus: DesktopPttHookStatus;
  isPlayingAudio: boolean;
  historyEntries: DesktopHistoryEntry[];
  backendHistorySummaries: DesktopBackendHistorySummary[];
  backendHistoryEntries: DesktopBackendHistoryMessage[];
  activeBackendHistoryUid: string;
  backendHistoryLoading: boolean;
  backendHistoryStatusMessage: string;
  bilibiliLiveStatus: BilibiliLiveStatus;
}

export interface DesktopRuntimeSnapshotInput {
  adapter: AdapterRuntimeProjection;
  motionEngineSettings: ModelEngineSettings;
  live2dPresentationSettings: Live2dPresentationSettings;
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
  motionEngineSettings: ModelEngineSettings;
  live2dPresentationSettings: Live2dPresentationSettings;
  motionPlaybackRecords: DesktopMotionPlaybackRecord[];
  connectionState: string;
  connectionLabel: string;
  connectionStatusMessage: string;
  aiState: string;
  micRequested: boolean;
  micCapturing: boolean;
  pttModeEnabled: boolean;
  pttKeyBinding: DesktopPttKeyBinding;
  pttHookStatus: DesktopPttHookStatus;
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
    pttHookStatus: { ...input.pttHookStatus },
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
    bilibiliLiveStatus: { ...input.bilibiliLiveStatus },
  };
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
    motionEngineSettings: cloneModelEngineSettings(input.motionEngineSettings),
    live2dPresentationSettings: cloneLive2dPresentationSettings(
      input.live2dPresentationSettings,
    ),
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
    pttHookStatus: { ...p.pttHookStatus },
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
  };
}
