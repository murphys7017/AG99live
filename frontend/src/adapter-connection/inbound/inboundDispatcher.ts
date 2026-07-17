/**
 * 入站事件分发的顶层路由。
 *
 * 上游 inboundEvents.ts 把原始信封映射成判别联合 InboundAdapterEvent；本文件按
 * event.kind 转发到下列五个领域分发器之一：
 *   - inboundConnectionDispatcher   server_info
 *   - inboundFeatureDispatcher      model_sync / 语义轴档案 / 动作样本 / 历史
 *   - inboundOutputDispatcher       output_segment / output_transcription
 *   - inboundRuntimeDispatcher      turn_started / turn_finished / interrupt / start_mic / synth_finished / control_error
 *   - inboundMotionDispatcher       engine_motion_preview
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
} from "../../types/protocol.js";
import type { InboundAdapterEvent, InboundEventMappingContext } from "./inboundEvents.js";
import { mapInboundEnvelopeToEvent } from "./inboundEvents.js";
import type { PendingAssistantTextItem, PendingAudioItem } from "../../playback-timeline/playbackReleaseQueue.js";
import type { NormalizedMotionPayload } from "../../playback-integrations/motionPayload.js";
import type { OutputSegmentMaterial } from "../../turn-playback/session.js";
import { dispatchInboundConnectionEvent } from "./inboundConnectionDispatcher.js";
import { dispatchInboundFeatureEvent } from "./inboundFeatureDispatcher.js";
import {
  dispatchInboundMotionPreviewEvent,
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
}

export interface InboundDispatchDeps {
  state: InboundDispatchState;
  sessionStore: {
    setActiveSession: (turnId: string | null) => void;
    markTurnStarted: (turnId: string | null) => void;
    markSynthFinished: (turnId: string | null) => void;
    markTurnFinished: (turnId: string | null, success: boolean, reason?: string) => void;
    markInterrupt: (turnId: string | null) => void;
    assertOutputSegmentsResolved: (turnId: string | null) => void;
    commitOutputSegment: (
      turnId: string | null,
      messageId: string,
      material: OutputSegmentMaterial,
    ) => void;
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
  acknowledgeMotionLabRawEventPersisted: (eventId: string) => void;
  // url rewriting
  rewriteModelSyncEnvelope: (envelope: ProtocolEnvelope<SystemModelSyncPayload>) => ProtocolEnvelope<SystemModelSyncPayload>;
  rewriteSocketUrl: (rawUrl: string) => string;
  rewriteHttpUrl: (rawUrl: string | null) => string;
  // audio
  stopAudioAndSettleTurn: (turnId: string | null, reason: string) => void;
  resetAudioPlaybackTerminal: () => void;
  hasPendingAudioForTurn: (turnId: string | null) => boolean;
  findActiveAudioSegment: () => { turnId: string | null; messageId: string } | null;
  reportRuntimeProtocolViolation: (message: string) => void;
  // text / audio queue
  queuePendingAssistantTextForPlayback: (map: Map<string, PendingAssistantTextItem>, text: string, turnId: string | null, messageId: string) => void;
  queuePendingAudioForPlayback: (map: Map<string, PendingAudioItem>, url: string, turnId: string | null, messageId: string) => void;
  playMotionPreviewPayload?: (payload: unknown) => boolean;
  normalizeMotionPayload: (payload: unknown) => { ok: true; payload: NormalizedMotionPayload } | { ok: false };
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
    case "motion_lab_raw_event_recorded":
    case "history_list":
    case "history_created":
    case "history_data":
    case "history_deleted":
      if (event.kind === "motion_lab_raw_event_recorded") {
        deps.acknowledgeMotionLabRawEventPersisted(event.envelope.payload.event_id);
      } else {
        dispatchInboundFeatureEvent(deps, event);
      }
      return;
    case "output_segment":
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
    case "engine_motion_preview":
      dispatchInboundMotionPreviewEvent(deps, event);
      return;
    case "unhandled":
      reportUnhandledInboundEnvelope(deps, event.envelope);
      return;
  }
}
