export type DesktopWindowRole = "pet" | "overlay" | "settings" | "history" | "action_lab";
export type DesktopAuxWindowRole = "settings" | "history" | "action_lab";

export interface DesktopWindowVisibilityState {
  petVisible: boolean;
  overlayVisible: boolean;
  settingsVisible: boolean;
  historyVisible: boolean;
  actionLabVisible: boolean;
}

export interface DesktopHistoryEntry {
  id: string;
  role: "user" | "assistant" | "system" | "error" | "transcription";
  text: string;
  timestamp: string;
}

export interface DesktopBaseActionPreviewAnalysis {
  status: string;
  mode: string;
  providerId: string;
  inputSignature: string;
  latencyMs: number;
  cacheHit: boolean;
  selectedChannelCount: number;
  error: string;
  fallbackReason: string;
}

export interface DesktopBaseActionPreviewSummary {
  motionCount: number;
  availableChannelCount: number;
  selectedChannelCount: number;
  candidateComponentCount: number;
  selectedAtomCount: number;
  familyCount: number;
}

export interface DesktopBaseActionPreviewFamily {
  name: string;
  label: string;
  channels: string[];
  atomCount: number;
}

export interface DesktopBaseActionPreviewChannel {
  name: string;
  label: string;
  family: string;
  familyLabel: string;
  domain: string;
  available: boolean;
  candidateComponentCount: number;
  selectedAtomCount: number;
  polarityModes: string[];
  atomIds: string[];
}

export interface DesktopBaseActionPreviewAtom {
  id: string;
  name: string;
  label: string;
  channel: string;
  channelLabel: string;
  family: string;
  familyLabel: string;
  domain: string;
  polarity: string;
  semanticPolarity: string;
  trait: string;
  strength: string;
  score: number;
  energyScore: number;
  primaryParameterMatch: boolean;
  channelPurity: number;
  sourceMotion: string;
  sourceFile: string;
  sourceGroup: string;
  sourceCategory: string;
  sourceTags: string[];
  duration: number;
  fps: number;
  loop: boolean;
  intensity: string;
}

export interface DesktopBaseActionPreview {
  schemaVersion: string;
  extractionMode: string;
  focusChannels: string[];
  focusDomains: string[];
  ignoredDomains: string[];
  summary: DesktopBaseActionPreviewSummary;
  analysis: DesktopBaseActionPreviewAnalysis;
  families: DesktopBaseActionPreviewFamily[];
  channels: DesktopBaseActionPreviewChannel[];
  atoms: DesktopBaseActionPreviewAtom[];
}

export interface DesktopRuntimeSnapshot {
  adapterAddress: string;
  desktopScreenshotOnSendEnabled: boolean;
  ambientMotionEnabled: boolean;
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
  baseActionPreview: DesktopBaseActionPreview | null;
}

export type DesktopRuntimeCommand =
  | { type: "set_address"; address: string }
  | { type: "set_desktop_screenshot_on_send"; enabled: boolean }
  | { type: "set_ambient_motion_enabled"; enabled: boolean }
  | { type: "connect"; address?: string }
  | { type: "disconnect" }
  | { type: "send_text"; text: string }
  | { type: "interrupt" }
  | { type: "toggle_mic_capture" }
  | { type: "preview_motion_plan"; plan: unknown };
