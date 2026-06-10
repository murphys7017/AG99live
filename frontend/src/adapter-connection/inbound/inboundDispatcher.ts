import type {
  ProtocolEnvelope,
  SystemModelSyncPayload,
} from "../../types/protocol.js";
import type { InboundAdapterEvent, InboundEventMappingContext } from "./inboundEvents.js";
import { mapInboundEnvelopeToEvent } from "./inboundEvents.js";
import type { PendingAssistantTextItem, PendingAudioItem } from "../runtime/playbackReleaseQueue.js";
import type { NormalizedMotionPayload } from "../../model-engine/contracts.js";
import { dispatchInboundConnectionEvent } from "./inboundConnectionDispatcher.js";
import { dispatchInboundFeatureEvent } from "./inboundFeatureDispatcher.js";
import { dispatchInboundMotionEvent } from "./inboundMotionDispatcher.js";
import { dispatchInboundOutputEvent } from "./inboundOutputDispatcher.js";
import {
  reportInboundProtocolError,
  reportUnhandledInboundEnvelope,
} from "./inboundProtocolDiagnostics.js";
import { dispatchInboundRuntimeEvent } from "./inboundRuntimeDispatcher.js";

// ── Dispatch context ───────────────────────────────────────────────

export interface InboundDispatchState {
  // session identity
  currentTurnId: string | null;
  // ui
  statusMessage: string;
  lastError: string;
  lastAssistantText: string;
  lastTranscription: string;
  lastImageCount: number;
  // turn finished
  turnFinishedTurnId: string | null;
  turnFinishedSuccess: boolean;
  turnFinishedReason: string;
  // mic
  micRequested: boolean;
  // audio io
  isPlayingAudio: boolean;
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackStartedMessageId: string | null;
  // server info
  serverInfo: {
    ws_url: string;
    http_base_url: string;
    auto_start_mic: boolean;
  } | null;
  // profile save result
  latestSemanticAxisProfileSaveResult: unknown;
  // pending queues
  pendingAssistantTexts: Map<string, PendingAssistantTextItem>;
  pendingAudios: Map<string, PendingAudioItem>;
  // motion plan
  inboundMotionPlan: unknown;
  inboundMotionPlanTurnId: string | null;
  inboundMotionPlanReceivedAtMs: number;
}

export interface InboundDispatchDeps {
  state: InboundDispatchState;
  sessionStore: {
    setActiveSession: (turnId: string | null) => void;
    markTurnStarted: (turnId: string | null) => void;
    markSynthFinished: (turnId: string | null) => void;
    markTurnFinished: (turnId: string | null, success: boolean, reason?: string) => void;
    markInterrupt: (turnId: string | null) => void;
    markTextReceived: (turnId: string | null, text: string, messageId: string, mode?: string) => void;
    markTextDelivered: (turnId: string | null, messageId: string) => void;
    markAudioReceived: (turnId: string | null, url: string, messageId: string) => boolean;
    markAudioTerminal: (turnId: string | null, terminal: string, messageId: string, reason?: string) => void;
    markMotionReceived: (turnId: string | null, payload: NormalizedMotionPayload, messageId: string) => void;
    ensureSegment: (turnId: string | null, messageId: string) => { text: { content: string | null } };
    getSessions: () => Array<{ segmentOrder: string[]; segments: Map<string, { messageId: string; turnId: string | null }> }>;
  } | undefined;
  pushHistory: (role: string, text: string) => void;
  modelSyncAdapter: { applyUnknownMessage: (envelope: ProtocolEnvelope<unknown>) => void } | null;
  historyAdapter: {
    applyHistoryList: (envelope: ProtocolEnvelope<unknown>) => void;
    applyHistoryCreated: (envelope: ProtocolEnvelope<unknown>) => void;
    applyHistoryData: (envelope: ProtocolEnvelope<unknown>) => void;
    applyHistoryDeleted: (envelope: ProtocolEnvelope<unknown>) => void;
  } | null;
  motionTuningAdapter: { applyMotionTuningSamplesState: (envelope: ProtocolEnvelope<unknown>) => void } | null;
  // url rewriting
  rewriteModelSyncEnvelope: (envelope: ProtocolEnvelope<SystemModelSyncPayload>) => ProtocolEnvelope<SystemModelSyncPayload>;
  rewriteSocketUrl: (rawUrl: string) => string;
  rewriteHttpUrl: (rawUrl: string | null) => string;
  // audio
  stopAudioAndSettleCurrent: (reason: string) => void;
  resetAudioPlaybackTerminal: () => void;
  markAudioPlaybackTerminal: (terminalState: string, turnId: string | null, reason?: string, messageId?: string | null) => void;
  hasPendingAudioForTurn: (turnId: string | null) => boolean;
  markMissingAudiosForTurn: (turnId: string | null, reason: string) => void;
  reportRuntimeProtocolViolation: (message: string) => void;
  // text / audio queue
  queuePendingAssistantTextForPlayback: (map: Map<string, PendingAssistantTextItem>, text: string, turnId: string | null, messageId: string) => void;
  queuePendingAudioForPlayback: (map: Map<string, PendingAudioItem>, url: string, turnId: string | null, messageId: string) => void;
  // motion
  findActiveAudioSegment: () => { turnId: string | null; messageId: string } | null;
  normalizeMotionPayload: (payload: unknown) => { ok: true; payload: NormalizedMotionPayload } | { ok: false };
  applyInboundMotionPayload: (
    ctx: {
      state: {
        currentTurnId: string | null;
        statusMessage: string;
        lastError: string;
        inboundMotionPlan: unknown;
        inboundMotionPlanTurnId: string | null;
        inboundMotionPlanReceivedAtMs: number;
      };
      activeAudioTurnId: string | null;
      pushHistory: (role: "system" | "error", text: string) => void;
    },
    envelope: ProtocolEnvelope<Record<string, unknown>>,
  ) => { accepted: false } | { accepted: true; rawPlan: Record<string, unknown> };
  // mic
  startMicrophoneCapture: (origin?: "manual" | "ptt" | "auto") => Promise<boolean>;
  // protocol warnings
  reportedProtocolWarnings: Set<string>;
  // build context
  buildInboundEventContext: () => InboundEventMappingContext;
}

// ── Main dispatch ──────────────────────────────────────────────────

export async function dispatchInboundEvent(
  deps: InboundDispatchDeps,
  event: InboundAdapterEvent,
): Promise<void> {
  switch (event.kind) {
    case "server_info":
      dispatchInboundConnectionEvent(deps, event);
      return;
    case "model_sync":
    case "semantic_axis_profile_saved":
    case "semantic_axis_profile_save_failed":
    case "motion_tuning_samples_state":
    case "history_list":
    case "history_created":
    case "history_data":
    case "history_deleted":
      dispatchInboundFeatureEvent(deps, event);
      return;
    case "output_text":
    case "output_audio":
    case "output_image":
    case "output_transcription":
      await dispatchInboundOutputEvent(deps, event);
      return;
    case "turn_started":
    case "turn_finished":
    case "interrupt":
    case "start_mic":
    case "synth_finished":
    case "control_error":
      dispatchInboundRuntimeEvent(deps, event);
      return;
    case "protocol_error":
      reportInboundProtocolError(deps, event);
      return;
    case "engine_motion_payload":
      dispatchInboundMotionEvent(deps, event);
      return;
    case "unhandled":
      reportUnhandledInboundEnvelope(deps, event.envelope);
      return;
  }
}
