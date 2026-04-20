export type DesktopWindowRole = "pet" | "overlay" | "settings" | "history";
export type DesktopAuxWindowRole = "settings" | "history";

export interface DesktopWindowVisibilityState {
  petVisible: boolean;
  overlayVisible: boolean;
  settingsVisible: boolean;
  historyVisible: boolean;
}

export interface DesktopHistoryEntry {
  id: string;
  role: "user" | "assistant" | "system" | "error" | "transcription";
  text: string;
  timestamp: string;
}

export interface DesktopRuntimeSnapshot {
  adapterAddress: string;
  desktopScreenshotOnSendEnabled: boolean;
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
  selectedModelName: string;
  selectedModelIconUrl: string;
  recommendedMode: string;
  serverWsUrl: string;
  httpBaseUrl: string;
  stageMessage: string;
  lastSentText: string;
  lastAssistantText: string;
  lastTranscription: string;
  lastImageCount: number;
  historyEntries: DesktopHistoryEntry[];
}

export type DesktopRuntimeCommand =
  | { type: "set_address"; address: string }
  | { type: "set_desktop_screenshot_on_send"; enabled: boolean }
  | { type: "connect"; address?: string }
  | { type: "disconnect" }
  | { type: "send_text"; text: string }
  | { type: "interrupt" }
  | { type: "toggle_mic_capture" };
