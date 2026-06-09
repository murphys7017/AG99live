import type {
  CatalogMotionPayload,
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
  usedActionLibrary: boolean;
  compiledParameterCount: number;
  timingSource: "hint" | "audio_sync" | "default";
  resolvedMode: "idle" | "expressive";
  source?: string;
  warnings?: string[];
  primaryAxes?: string[];
  hintAxes?: string[];
  derivedAxes?: string[];
  availableDerivedAxes?: string[];
  appliedDerivedAxes?: string[];
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
  activeGroups?: string[];
  skeletonGroups?: string[];
  missingSkeletonGroups?: string[];
  maxDeltaFromNeutral?: number;
  neutralishAxisCount?: number;
  expressiveAxisCount?: number;
  semanticAxisCount?: number;
  couplingSkippedExplicitTargets?: string[];
}

interface DesktopMotionPlaybackRecordBase {
  id: string;
  createdAt: string;
  source: string;
  payloadKind: "semantic_intent" | "semantic_plan" | "catalog_motion";
  messageId: string;
  turnId: string | null;
  playbackTurnId: string | null;
  modelName: string;
  emotionLabel: string;
  mode: "idle" | "expressive";
  startReason: string;
  queuedDelayMs: number;
  assistantText: string;
  playerMessage: string;
  diagnostics: DesktopMotionCompileDiagnostics | null;
}

export type DesktopMotionPlaybackRecord =
  | (DesktopMotionPlaybackRecordBase & {
    payloadKind: "semantic_intent" | "semantic_plan";
    plan: MotionPlanPayload;
    motion?: null;
  })
  | (DesktopMotionPlaybackRecordBase & {
    payloadKind: "catalog_motion";
    motion: CatalogMotionPayload;
    plan?: null;
  });

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

export interface DesktopMotionTuningEffectiveExample {
  input: string;
  output: {
    emotion: string;
    mode: string;
    durationMs: number | null;
    axes: Record<string, number>;
  };
  source: string;
  tags: readonly string[];
}

export function hasPinnedProfileScope(
  sample: Pick<DesktopMotionTuningSample, "profileId" | "profileRevision">,
): sample is Pick<DesktopMotionTuningSample, "profileId" | "profileRevision"> & {
  profileId: string;
  profileRevision: number;
} {
  return (
    typeof sample.profileId === "string"
    && sample.profileId.trim().length > 0
    && typeof sample.profileRevision === "number"
    && Number.isFinite(sample.profileRevision)
    && sample.profileRevision > 0
  );
}

export function matchesPinnedProfileScope(
  sample: Pick<DesktopMotionTuningSample, "profileId" | "profileRevision">,
  profile: Pick<SemanticAxisProfile, "profile_id" | "revision"> | null | undefined,
): boolean {
  if (!profile || !hasPinnedProfileScope(sample)) {
    return false;
  }
  return (
    sample.profileId === profile.profile_id
    && sample.profileRevision === profile.revision
  );
}

export function matchesProfileIdentityScope(
  sample: Pick<DesktopMotionTuningSample, "profileId">,
  profile: Pick<SemanticAxisProfile, "profile_id"> | null | undefined,
): boolean {
  if (!profile) {
    return false;
  }
  return (
    typeof sample.profileId === "string"
    && sample.profileId.trim().length > 0
    && sample.profileId === profile.profile_id
  );
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

export interface DesktopModelProjectionSnapshot {
  selectedModelName: string;
  selectedModelIconUrl: string;
  recommendedMode: string;
  confName: string;
  lastUpdated: string;
  runtimeSemanticAxisProfile: SemanticAxisProfile | null;
  baseActionPreview: DesktopBaseActionPreview | null;
  motionTuningEffectiveExamples: DesktopMotionTuningEffectiveExample[];
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
  microphoneDeviceId: string;
  microphoneDevices: DesktopMicrophoneDevice[];
  ambientMotionEnabled: boolean;
  motionEngineSettings: DesktopMotionEngineSettings;
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
  activeSessionId: string | null;
  activeSessionPhase: string;
  activeSessionTextReady: boolean;
  activeSessionAudioTerminal: string;
  activeSessionMotionStarted: boolean;
  activeSessionMotionCompleted: boolean;
  activeSessionSynthFinished: boolean;
  activeSessionTurnFinished: boolean;
}

export interface DesktopMicrophoneDevice {
  deviceId: string;
  label: string;
}

export interface DesktopMicrophoneAudioChunk {
  audio?: number[];
  pcm16le?: ArrayBuffer;
  sampleRate: number;
  channels: 1;
}

export interface DesktopPttKeyBinding {
  code: string;
  label: string;
  uiohookKeycode: number | null;
}

export type DesktopPttEventKind = "keydown" | "keyup";

export interface DesktopPttEventPayload {
  eventId: string;
  kind: DesktopPttEventKind;
  keycode: number;
  createdAt: string;
}

export type DesktopPttAckStatus =
  | "received"
  | "started"
  | "stopped"
  | "discarded"
  | "ignored"
  | "failed";

export interface DesktopPttEventAck {
  eventId: string;
  kind: DesktopPttEventKind;
  status: DesktopPttAckStatus;
  message?: string;
  timestamp: string;
}

export interface DesktopMotionTuningSamplesStatus {
  rootError: string;
  loadError: string;
  diagnostics: readonly string[];
  effectiveExamples: readonly DesktopMotionTuningEffectiveExample[];
}

export type DesktopRuntimeCommand =
  | { type: "set_address"; address: string }
  | { type: "set_desktop_screenshot_on_send"; enabled: boolean }
  | { type: "set_microphone_device"; deviceId: string }
  | { type: "set_microphone_devices"; devices: DesktopMicrophoneDevice[] }
  | { type: "refresh_microphone_devices" }
  | { type: "set_ambient_motion_enabled"; enabled: boolean }
  | { type: "set_motion_engine_settings"; settings: DesktopMotionEngineSettings }
  | { type: "request_model_projection_sync" }
  | { type: "request_motion_tuning_samples_sync" }
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
  | { type: "set_ptt_mode"; enabled: boolean }
  | { type: "set_ptt_key_binding"; binding: DesktopPttKeyBinding }
  | { type: "preview_motion_payload"; payload: unknown };
