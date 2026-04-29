import type {
  MotionPlanPayload,
} from "./protocol";
import type { SemanticAxisProfile } from "./semantic-axis-profile";

export type DesktopWindowRole =
  | "pet"
  | "overlay"
  | "settings"
  | "history"
  | "action_lab"
  | "profile_editor";
export type DesktopAuxWindowRole = "settings" | "history" | "action_lab" | "profile_editor";

export interface DesktopWindowVisibilityState {
  petVisible: boolean;
  overlayVisible: boolean;
  settingsVisible: boolean;
  historyVisible: boolean;
  actionLabVisible: boolean;
  profileEditorVisible?: boolean;
}

export interface DesktopHistoryEntry {
  id: string;
  role: "user" | "assistant" | "system" | "error" | "transcription";
  text: string;
  timestamp: string;
}

export interface DesktopBackendHistorySummaryMessage {
  role: "human" | "ai" | "system";
  timestamp: string;
  content: string;
}

export interface DesktopBackendHistorySummary {
  uid: string;
  latestMessage: DesktopBackendHistorySummaryMessage | null;
  timestamp: string;
}

export interface DesktopBackendHistoryMessage {
  id: string;
  role: "human" | "ai" | "system";
  type: string;
  content: string;
  timestamp: string;
  name?: string;
  toolId?: string;
  toolName?: string;
  status?: string;
  avatar?: string;
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

export interface DesktopMotionEngineSettings {
  motionIntensityScale: number;
  axisIntensityScale: Record<string, number>;
}

export interface DesktopMotionCompileDiagnostics {
  usedFallbackLibrary: boolean;
  supplementaryCount: number;
  timingSource: "hint" | "audio_sync" | "default";
  resolvedMode: "idle" | "expressive";
  source?: string;
  warnings?: string[];
  primaryAxes?: string[];
  hintAxes?: string[];
  derivedAxes?: string[];
  runtimeAxes?: string[];
  missingAxes?: string[];
  forbiddenAxes?: string[];
  invalidAxes?: string[];
  axisErrorCount?: number;
  axisErrorLimit?: number;
  compiledParameters?: string[];
  intensityApplied: boolean;
  motionIntensityScale: number;
  axisIntensityScale: Record<string, number>;
}

export interface DesktopMotionPlaybackRecord {
  id: string;
  createdAt: string;
  source: string;
  payloadKind: "semantic_intent" | "semantic_plan";
  turnId: string | null;
  modelName: string;
  emotionLabel: string;
  mode: "idle" | "expressive";
  startReason: string;
  queuedDelayMs: number;
  assistantText: string;
  playerMessage: string;
  diagnostics: DesktopMotionCompileDiagnostics | null;
  plan: MotionPlanPayload;
}

export interface DesktopMotionTuningSample {
  id: string;
  createdAt: string;
  sourceRecordId: string;
  modelName: string;
  profileId?: string;
  profileRevision?: number;
  emotionLabel: string;
  assistantText: string;
  feedback: string;
  tags: string[];
  enabledForLlmReference?: boolean;
  originalAxes: Record<string, number>;
  adjustedAxes: Record<string, number>;
  adjustedPlan: MotionPlanPayload;
}

export interface DesktopSemanticAxisProfileSaveResult {
  requestId: string;
  ok: boolean;
  modelName: string;
  profileId: string;
  expectedRevision?: number;
  revision?: number;
  sourceHash?: string;
  savedAt?: string;
  errorCode?: string;
  message?: string;
  receivedAt: string;
}

export interface DesktopProfileAuthoringSnapshot {
  latestSemanticAxisProfileSaveResult: DesktopSemanticAxisProfileSaveResult | null;
}

export type DesktopProfileAuthoringCommand = {
  type: "save_semantic_axis_profile";
  requestId: string;
  modelName: string;
  profileId: string;
  expectedRevision: number;
  profile: SemanticAxisProfile;
};

export interface DesktopRuntimeSnapshot {
  adapterAddress: string;
  desktopScreenshotOnSendEnabled: boolean;
  ambientMotionEnabled: boolean;
  motionEngineSettings: DesktopMotionEngineSettings;
  motionPlaybackRecords: DesktopMotionPlaybackRecord[];
  motionTuningSamples: DesktopMotionTuningSample[];
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
  backendHistorySummaries: DesktopBackendHistorySummary[];
  backendHistoryEntries: DesktopBackendHistoryMessage[];
  activeBackendHistoryUid: string;
  backendHistoryLoading: boolean;
  backendHistoryStatusMessage: string;
  runtimeSemanticAxisProfile: SemanticAxisProfile | null;
  baseActionPreview: DesktopBaseActionPreview | null;
}

export type DesktopRuntimeCommand =
  | { type: "set_address"; address: string }
  | { type: "set_desktop_screenshot_on_send"; enabled: boolean }
  | { type: "set_ambient_motion_enabled"; enabled: boolean }
  | { type: "set_motion_engine_settings"; settings: DesktopMotionEngineSettings }
  | { type: "save_motion_tuning_sample"; sample: DesktopMotionTuningSample }
  | { type: "delete_motion_tuning_sample"; sampleId: string }
  | { type: "request_history_list" }
  | { type: "create_history" }
  | { type: "load_history"; historyUid: string }
  | { type: "delete_history"; historyUid: string }
  | { type: "connect"; address?: string }
  | { type: "disconnect" }
  | { type: "send_text"; text: string }
  | { type: "interrupt" }
  | { type: "toggle_mic_capture" }
  | { type: "preview_motion_payload"; payload: unknown }
  | { type: "preview_motion_plan"; plan: unknown };
