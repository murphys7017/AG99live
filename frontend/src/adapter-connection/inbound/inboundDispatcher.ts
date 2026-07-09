/**
 * 入站事件分发的顶层路由。
 *
 * 上游 inboundEvents.ts 把原始信封映射成判别联合 InboundAdapterEvent；本文件按
 * event.kind 转发到下列五个领域分发器之一：
 *   - inboundConnectionDispatcher   server_info
 *   - inboundFeatureDispatcher      model_sync / 语义轴档案 / 动作样本 / 历史
 *   - inboundOutputDispatcher       output_text / output_audio / output_image / output_transcription
 *   - inboundRuntimeDispatcher      turn_started / turn_finished / interrupt / start_mic / synth_finished / control_error
 *   - inboundMotionDispatcher       engine_motion_payload / engine_motion_preview
 * protocol_error 和 unhandled 走 inboundProtocolDiagnostics 上报。
 *
 * 自身不写状态、不发协议、不调用任何业务行为，只做 switch + forward；状态写回
 * 由各领域分发器完成。InboundDispatchDeps 是它们共享的依赖集合（session 写回、
 * 音频运行时、URL 重写、pending 队列工具等），由 createAdapterInboundRuntime 装配。
 */

import type {
  ProtocolEnvelope,
  SystemHistoryCreatedPayload,
  SystemHistoryDataPayload,
  SystemHistoryDeletedPayload,
  SystemHistoryListPayload,
  SystemModelSyncPayload,
  SystemMotionTuningSamplesStatePayload,
  PerformanceCurveHint,
} from "../../types/protocol.js";
import type { InboundAdapterEvent, InboundEventMappingContext } from "./inboundEvents.js";
import { mapInboundEnvelopeToEvent } from "./inboundEvents.js";
import type { PendingAssistantTextItem, PendingAudioItem } from "../../playback-timeline/playbackReleaseQueue.js";
import type { NormalizedMotionPayload } from "../../model-engine/contracts.js";
import type { PendingMotionItem } from "./pendingMotionIngress.js";
import { dispatchInboundConnectionEvent } from "./inboundConnectionDispatcher.js";
import { dispatchInboundFeatureEvent } from "./inboundFeatureDispatcher.js";
import {
  dispatchInboundMotionEvent,
  dispatchInboundMotionPreviewEvent,
  dispatchInboundPerformanceCurveHintEvent,
} from "./inboundMotionDispatcher.js";
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
  pttModeEnabled: boolean;
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
  pendingMotions: Map<string, PendingMotionItem>;
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
    markTextReceived: (turnId: string | null, text: string, messageId: string, mode?: string, audioExpected?: boolean) => void;
    markTextDelivered: (turnId: string | null, messageId: string) => void;
    markAudioReceived: (turnId: string | null, url: string, messageId: string, captionText?: string) => boolean;
    markAudioTerminal: (turnId: string | null, terminal: string, messageId: string, reason?: string) => void;
    markMotionReceived: (turnId: string | null, payload: NormalizedMotionPayload, messageId: string) => void;
    markPerformanceCurveHintReceived: (turnId: string | null, hint: PerformanceCurveHint, messageId: string) => void;
    canAcceptOutputSegment: (turnId: string | null, messageId: string) => boolean;
    ensureSegment: (turnId: string | null, messageId: string) => { text: { content: string | null } };
    getSessions: () => Array<{ segmentOrder: string[]; segments: Map<string, { messageId: string; turnId: string | null }> }>;
  } | undefined;
  pushHistory: (role: string, text: string) => void;
  modelSyncAdapter: {
    applyUnknownMessage: (envelope: ProtocolEnvelope<unknown>) => void;
    applyModelSyncMessage: (envelope: ProtocolEnvelope<SystemModelSyncPayload>) => void;
  } | null;
  historyAdapter: {
    applyHistoryList: (envelope: ProtocolEnvelope<SystemHistoryListPayload>) => void;
    applyHistoryCreated: (envelope: ProtocolEnvelope<SystemHistoryCreatedPayload>) => void;
    applyHistoryData: (envelope: ProtocolEnvelope<SystemHistoryDataPayload>) => void;
    applyHistoryDeleted: (envelope: ProtocolEnvelope<SystemHistoryDeletedPayload>) => void;
  } | null;
  motionTuningAdapter: { applyMotionTuningSamplesState: (envelope: ProtocolEnvelope<SystemMotionTuningSamplesStatePayload>) => void } | null;
  // url rewriting
  rewriteModelSyncEnvelope: (envelope: ProtocolEnvelope<SystemModelSyncPayload>) => ProtocolEnvelope<SystemModelSyncPayload>;
  rewriteSocketUrl: (rawUrl: string) => string;
  rewriteHttpUrl: (rawUrl: string | null) => string;
  // audio
  stopAudioAndSettleTurn: (turnId: string | null, reason: string) => void;
  resetAudioPlaybackTerminal: () => void;
  markAudioPlaybackTerminal: (terminalState: string, turnId: string | null, reason?: string, messageId?: string | null) => void;
  hasPendingAudioForTurn: (turnId: string | null) => boolean;
  markMissingAudiosForTurn: (turnId: string | null, reason: string) => void;
  markMissingMotionsForTurn: (turnId: string | null, reason: string) => void;
  findActiveAudioSegment: () => { turnId: string | null; messageId: string } | null;
  reportRuntimeProtocolViolation: (message: string) => void;
  // text / audio queue
  queuePendingAssistantTextForPlayback: (map: Map<string, PendingAssistantTextItem>, text: string, turnId: string | null, messageId: string) => void;
  queuePendingAudioForPlayback: (map: Map<string, PendingAudioItem>, url: string, turnId: string | null, messageId: string) => void;
  flushPendingMotionForSegment: (turnId: string | null, messageId: string) => void;
  playMotionPreviewPayload?: (payload: unknown) => boolean;
  // motion
  hasPlaybackSegment: (turnId: string | null, messageId: string) => boolean;
  canQueuePendingMotionForTurn: (turnId: string | null) => boolean;
  canAcceptSegmentPatch: (turnId: string | null, messageId: string) => boolean;
  queuePendingMotionForSegment: (
    turnId: string | null,
    messageId: string,
    payload: NormalizedMotionPayload,
  ) => void;
  clearPendingMotionsForTurn: (turnId: string | null, reason: string) => void;
  rejectSegmentPatchWithoutOutput: (
    kind: string,
    turnId: string | null,
    messageId: string,
  ) => void;
  rejectSegmentPatchAfterSynthFinished: (
    kind: string,
    turnId: string | null,
    messageId: string,
  ) => void;
  rejectOutputAfterSynthFinished: (
    kind: string,
    turnId: string | null,
    messageId: string,
  ) => void;
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

/**
 * 入站事件的顶层 switch，按 event.kind 转发到对应领域分发器。
 *
 * 自身只 forward，不读写任何 state、不发协议、不抛异常。output_* 是 async 的，
 * 其他分支同步执行；调用方需要 await 返回值以保证 output 路径下的副作用顺序。
 */
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
    case "engine_motion_preview":
      dispatchInboundMotionPreviewEvent(deps, event);
      return;
    case "engine_performance_curve_hint":
      dispatchInboundPerformanceCurveHintEvent(deps, event);
      return;
    case "unhandled":
      reportUnhandledInboundEnvelope(deps, event.envelope);
      return;
  }
}
