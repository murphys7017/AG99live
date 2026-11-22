import { reactive } from "vue";
import type {
  DesktopHistoryEntry,
  DesktopMotionTuningSample,
  DesktopMotionTuningSamplesStatus,
  DesktopPttHookStatus,
  DesktopSemanticAxisProfileSaveResult,
} from "../../types/desktop.js";
import type { SystemServerInfoPayload } from "../../types/protocol.js";
import type { MicrophoneDeviceInfo } from "../runtime/microphoneDevices.js";
import {
  loadDesktopScreenshotOnSendEnabled,
  loadPersonaSegmentStreamEnabled,
  loadStoredAdapterAddress,
  loadStoredMicrophoneDeviceId,
  loadStoredPttKeyBinding,
  loadStoredPttModeEnabled,
} from "../core/preferences.js";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type AdapterConnectionState = ReturnType<typeof createAdapterConnectionState>;

export const DEFAULT_PTT_HOOK_STATUS: DesktopPttHookStatus = {
  available: true,
  enabled: false,
  keycode: null,
  reason: "",
  updatedAt: "",
};

export function createAdapterConnectionState() {
  return reactive({
    address: loadStoredAdapterAddress(),
    desktopScreenshotOnSendEnabled: loadDesktopScreenshotOnSendEnabled(),
    personaSegmentStreamEnabled: loadPersonaSegmentStreamEnabled(),
    microphoneDeviceId: loadStoredMicrophoneDeviceId(),
    microphoneDevices: [] as MicrophoneDeviceInfo[],
    status: "disconnected" as ConnectionStatus,
    statusMessage: "尚未连接适配器。",
    desktopSettingsSyncReady: false,
    serverInfo: null as SystemServerInfoPayload | null,
    activeWsAddress: "",
    lastError: "",
    lastAssistantText: "",
    lastTranscription: "",
    lastImageCount: 0,
    currentTurnId: null as string | null,
    micCapturing: false,
    vadSpeechActive: false,
    microphoneStandby: false,
    pttModeEnabled: loadStoredPttModeEnabled(),
    pttKeyBinding: loadStoredPttKeyBinding(),
    pttHookStatus: { ...DEFAULT_PTT_HOOK_STATUS },
    isPlayingAudio: false,
    historyEntries: [] as DesktopHistoryEntry[],
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
  });
}
