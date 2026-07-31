import type {
  CatalogMotionPayload,
  MotionPlanPayload,
} from "./protocol";
import { SCHEMA_MOTION_TUNING_SAMPLE_V2 } from "./protocol";
import type { SemanticAxisProfile } from "./semantic-axis-profile";
import type { CompiledSemanticMotion } from "../model-engine/compiler/contracts";
import type {
  BilibiliLiveSettings,
  BilibiliLiveStatus,
} from "./bilibili-live";

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
}

export interface DesktopLive2dPresentationSettings {
  ambientMotionEnabled: boolean;
  physicsResponseScale: number;
  renderDprCap: number;
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
  activeGroups?: string[];
  skeletonGroups?: string[];
  missingSkeletonGroups?: string[];
  maxDeltaFromNeutral?: number;
  neutralishAxisCount?: number;
  expressiveAxisCount?: number;
  semanticAxisCount?: number;
  failureStage?: string;
  relationSkippedExplicitTargets?: string[];
  transformTrace?: {
    transformVersion: string;
    profileRevision: number;
    profileHash: string;
    rawAxes: Record<string, number>;
    rawAxisLevels?: Record<string, number>;
    rawMotionSteps?: Array<{
      axis_levels: Record<string, number>;
      duration_weight: number;
    }>;
    axisSampling?: {
      seed: string;
      sharedRandom: number;
      perAxisRandom: Record<string, number>;
      sampledValues: Record<string, number>;
      sampleBounds: Record<string, { min: number; max: number }>;
    };
    resolvedAxes: Record<string, number>;
    derivedAxes: Record<string, number>;
    constrainedAxes: Record<string, number>;
    sequenceSteps?: Array<{
      index: number;
      durationWeight: number;
      resolvedAxes: Record<string, number>;
      constrainedAxes: Record<string, number>;
      axisSampling?: {
        seed: string;
        sharedRandom: number;
        perAxisRandom: Record<string, number>;
        sampledValues: Record<string, number>;
        sampleBounds: Record<string, { min: number; max: number }>;
      };
    }>;
    relationAdjustments: unknown[];
    compiledParameters: string[];
  };
}

interface DesktopMotionPlaybackRecordBase {
  id: string;
  createdAt: string;
  source: string;
  payloadKind: "semantic_intent" | "semantic_motion_resource" | "catalog_motion" | "speech_only";
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
    payloadKind: "semantic_intent" | "speech_only";
    plan: MotionPlanPayload;
    semanticMotion: CompiledSemanticMotion;
    motion?: null;
  })
  | (DesktopMotionPlaybackRecordBase & {
    payloadKind: "catalog_motion";
    motion: CatalogMotionPayload;
    plan?: null;
  })
  | (DesktopMotionPlaybackRecordBase & {
    payloadKind: "semantic_motion_resource";
    motion: CatalogMotionPayload;
    plan?: null;
  });

export interface DesktopMotionTuningSample {
  schemaVersion: typeof SCHEMA_MOTION_TUNING_SAMPLE_V2;
  id: string;
  createdAt: string;
  sourceRecordId: string;
  turnId: string;
  messageId: string;
  modelName: string;
  profileId?: string;
  profileRevision?: number;
  profileHash?: string;
  transformVersion?: string;
  emotionLabel: string;
  userText: string;
  assistantText: string;
  feedback: string;
  tags: string[];
  enabledForLlmReference?: boolean;
  originalAxes: Record<string, number>;
  rawAxisLevels?: Record<string, number>;
  resolvedAxes?: Record<string, number>;
  constrainedAxes?: Record<string, number>;
  adjustedAxes?: Record<string, number>;
  compiledSemanticMotion: CompiledSemanticMotion;
}

export interface DesktopMotionTuningEffectiveExample {
  category: string;
  input: string;
  output: {
    intentTags: readonly string[];
    durationHintMs: number | null;
    axisLevels?: Record<string, number>;
    motionSteps?: readonly {
      axisLevels: Record<string, number>;
      durationWeight: number;
    }[];
    expressionResourceId?: string;
    motionResourceId?: string;
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
  /** 快照发布者标识符（窗口实例 mount 时随机生成） */
  _publisherId: string;
  /** 单调递增的快照版本号（每次 publish 自增，值大的优先） */
  _revision: number;
  adapterAddress: string;
  desktopScreenshotOnSendEnabled: boolean;
  microphoneDeviceId: string;
  microphoneDevices: DesktopMicrophoneDevice[];
  motionEngineSettings: DesktopMotionEngineSettings;
  live2dPresentationSettings: DesktopLive2dPresentationSettings;
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

export interface DesktopPttHookStatus {
  available: boolean;
  enabled: boolean;
  keycode: number | null;
  reason: string;
  updatedAt: string;
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

export interface DesktopMotionPreviewStatus {
  requestId: string;
  source: "compiled_semantic_motion";
  status:
    | "requested"
    | "started"
    | "rejected"
    | "completed"
    | "failed"
    | "stopped";
  runId?: string;
  reason?: string;
}

export type DesktopRuntimeCommand =
  | { type: "set_address"; address: string }
  | { type: "set_desktop_screenshot_on_send"; enabled: boolean }
  | { type: "set_microphone_device"; deviceId: string }
  | { type: "set_microphone_devices"; devices: DesktopMicrophoneDevice[] }
  | { type: "refresh_microphone_devices" }
  | { type: "set_motion_engine_settings"; settings: DesktopMotionEngineSettings }
  | { type: "set_live2d_presentation_settings"; settings: DesktopLive2dPresentationSettings }
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
  | { type: "set_bilibili_live_settings"; settings: BilibiliLiveSettings }
  | {
    type: "preview_compiled_semantic_motion";
    requestId: string;
    semanticMotion: CompiledSemanticMotion;
  };
