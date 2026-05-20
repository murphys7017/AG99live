import { reactive } from "vue";
import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopHistoryEntry,
  DesktopMotionTuningSample,
  DesktopMotionTuningSamplesStatus,
  DesktopSemanticAxisProfileSaveResult,
} from "../../types/desktop.js";
import type { SystemServerInfoPayload } from "../../types/protocol.js";
import type { MicrophoneDeviceInfo } from "../runtime/microphoneDevices.js";
import type { AudioPlaybackTerminalState } from "../runtime/audioRuntime.js";
import type {
  PendingAssistantTextItem,
  PendingAudioItem,
} from "../runtime/playbackReleaseQueue.js";
import {
  loadDesktopScreenshotOnSendEnabled,
  loadStoredAdapterAddress,
  loadStoredMicrophoneDeviceId,
} from "../core/preferences.js";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type AdapterConnectionState = ReturnType<typeof createAdapterConnectionState>;

export function createAdapterConnectionState() {
  return reactive({
    address: loadStoredAdapterAddress(),
    desktopScreenshotOnSendEnabled: loadDesktopScreenshotOnSendEnabled(),
    microphoneDeviceId: loadStoredMicrophoneDeviceId(),
    microphoneDevices: [] as MicrophoneDeviceInfo[],
    status: "disconnected" as ConnectionStatus,
    statusMessage: "尚未连接适配器。",
    serverInfo: null as SystemServerInfoPayload | null,
    activeWsAddress: "",
    lastError: "",
    lastAssistantText: "",
    lastTranscription: "",
    lastImageCount: 0,
    currentTurnId: null as string | null,
    micRequested: false,
    micCapturing: false,
    pttModeEnabled: false,
    isPlayingAudio: false,
    historyEntries: [] as DesktopHistoryEntry[],
    backendHistorySummaries: [] as DesktopBackendHistorySummary[],
    backendHistoryEntries: [] as DesktopBackendHistoryMessage[],
    activeBackendHistoryUid: "",
    backendHistoryLoading: false,
    backendHistoryStatusMessage: "等待历史窗口请求后端历史。",
    inboundMotionPlan: null as unknown | null,
    inboundMotionPlanTurnId: null as string | null,
    inboundMotionPlanReceivedAtMs: 0,
    pendingAssistantTexts: new Map<string, PendingAssistantTextItem>(),
    pendingAudios: new Map<string, PendingAudioItem>(),
    audioPlaybackStartedTurnId: null as string | null,
    audioPlaybackStartedMessageId: null as string | null,
    audioPlaybackStartedAtMs: 0,
    audioPlaybackDurationMs: null as number | null,
    audioPlaybackTerminalState: "idle" as AudioPlaybackTerminalState,
    audioPlaybackTerminalTurnId: null as string | null,
    audioPlaybackTerminalReason: "",
    assistantTextDeliveryTurnId: null as string | null,
    turnFinishedTurnId: null as string | null,
    turnFinishedSuccess: true,
    turnFinishedReason: "",
    latestSemanticAxisProfileSaveResult: null as DesktopSemanticAxisProfileSaveResult | null,
    motionTuningSamples: [] as DesktopMotionTuningSample[],
    motionTuningSamplesStatus: {
      rootError: "",
      loadError: "",
      diagnostics: [],
      effectiveExamples: [],
    } as DesktopMotionTuningSamplesStatus,
    expressionExampleOverridesRevision: 0,
  });
}
