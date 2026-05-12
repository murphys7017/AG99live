import type {
  ControlErrorPayload,
  OutputAudioPayload,
  OutputImagePayload,
  OutputTextPayload,
  OutputTranscriptionPayload,
  ProtocolEnvelope,
  SystemSemanticAxisProfileSaveFailedPayload,
  SystemSemanticAxisProfileSavedPayload,
  SystemServerInfoPayload,
  SystemModelSyncPayload,
} from "../types/protocol.js";
import type { InboundAdapterEvent, InboundEventMappingContext } from "./inboundEvents.js";
import { mapInboundEnvelopeToEvent } from "./inboundEvents.js";
import type {
  InboundMotionApplyResult,
  InboundMotionContext,
} from "./inboundMotion.js";
import type { PendingAssistantTextItem, PendingAudioItem } from "./playbackReleaseQueue.js";
import type { NormalizedMotionPayload } from "../model-engine/contracts.js";

// ── Dispatch context ───────────────────────────────────────────────

export interface InboundDispatchState {
  // session identity
  currentTurnId: string | null;
  currentOrchestrationId: string | null;
  // ui
  statusMessage: string;
  lastError: string;
  lastAssistantText: string;
  lastTranscription: string;
  lastImageCount: number;
  // turn finished
  turnFinishedTurnId: string | null;
  turnFinishedOrchestrationId: string | null;
  turnFinishedSuccess: boolean;
  turnFinishedReason: string;
  // mic
  micRequested: boolean;
  // audio io
  isPlayingAudio: boolean;
  // server info
  serverInfo: SystemServerInfoPayload | null;
  // profile save result
  latestSemanticAxisProfileSaveResult: unknown;
  // pending queues
  pendingAssistantTexts: Map<string, PendingAssistantTextItem>;
  pendingAudios: Map<string, PendingAudioItem>;
  // motion plan
  inboundMotionPlan: unknown;
  inboundMotionPlanTurnId: string | null;
  inboundMotionPlanOrchestrationId: string | null;
  inboundMotionPlanReceivedAtMs: number;
}

export interface InboundDispatchDeps {
  state: InboundDispatchState;
  sessionStore: {
    setActiveSession: (orchestrationId: string | null, turnId: string | null) => void;
    markTurnStarted: (orchestrationId: string | null, turnId: string | null) => void;
    markSynthFinished: (orchestrationId: string | null, turnId: string | null) => void;
    markTurnFinished: (orchestrationId: string | null, turnId: string | null, success: boolean, reason?: string) => void;
    markInterrupt: (orchestrationId: string | null, turnId: string | null) => void;
    markTextReceived: (orchId: string | null, turnId: string | null, text: string, messageId: string, mode?: string) => void;
    markTextDelivered: (orchId: string | null, turnId: string | null, messageId: string) => void;
    markAudioReceived: (orchId: string | null, turnId: string | null, url: string, messageId: string) => void;
    markAudioTerminal: (orchId: string | null, turnId: string | null, terminal: string, messageId: string, reason?: string) => void;
    markMotionReceived: (orchId: string | null, turnId: string | null, payload: NormalizedMotionPayload, messageId: string) => void;
    ensureSegment: (orchId: string | null, turnId: string | null, messageId: string) => { text: { content: string | null } };
    getSessions: () => Array<{ segmentOrder: string[]; segments: Map<string, { messageId: string; turnId: string | null; orchestrationId: string | null }> }>;
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
  stopAudioPlayback: () => void;
  resetAudioPlaybackTerminal: () => void;
  markAudioPlaybackTerminal: (terminalState: string, turnId: string | null, orchestrationId: string | null, reason?: string, messageId?: string | null) => void;
  hasPendingAudioForTurn: (turnId: string | null, orchestrationId: string | null) => boolean;
  markMissingAudiosForTurn: (turnId: string | null, orchestrationId: string | null, reason: string) => void;
  // text / audio queue
  queuePendingAssistantTextForPlayback: (map: Map<string, PendingAssistantTextItem>, text: string, turnId: string | null, orchestrationId: string | null, messageId: string) => void;
  queuePendingAudioForPlayback: (map: Map<string, PendingAudioItem>, url: string, turnId: string | null, orchestrationId: string | null, messageId: string) => void;
  // motion
  findActiveAudioSegment: () => { turnId: string | null; orchestrationId: string | null; messageId: string } | null;
  normalizeMotionPayload: (payload: unknown) => { ok: true; payload: NormalizedMotionPayload } | { ok: false };
  applyInboundMotionPayload: (
    ctx: InboundMotionContext,
    envelope: ProtocolEnvelope<Record<string, unknown>>,
  ) => InboundMotionApplyResult;
  // mic
  startMicrophoneCapture: () => Promise<boolean>;
  // protocol warnings
  reportedProtocolWarnings: Set<string>;
  // build context
  buildInboundEventContext: () => InboundEventMappingContext;
}

// ── Handler functions ──────────────────────────────────────────────

function applyServerInfoMessage(
  deps: InboundDispatchDeps,
  envelope: ProtocolEnvelope<SystemServerInfoPayload>,
): void {
  const s = deps.state;
  s.serverInfo = {
    ...envelope.payload,
    ws_url: deps.rewriteSocketUrl(envelope.payload.ws_url),
    http_base_url: deps.rewriteHttpUrl(envelope.payload.http_base_url),
  };
  s.micRequested = s.serverInfo.auto_start_mic;
  s.statusMessage = "适配器已连接，等待模型同步。";
  deps.pushHistory("system", "收到后端运行信息。");
  if (s.serverInfo.auto_start_mic) {
    void deps.startMicrophoneCapture();
  }
}

function applyOutputText(
  deps: InboundDispatchDeps,
  event: Extract<InboundAdapterEvent, { kind: "output_text" }>,
): void {
  const s = deps.state;
  s.currentTurnId = event.turnId;
  s.currentOrchestrationId = event.orchestrationId;
  const text = event.text;
  if (text) {
    deps.queuePendingAssistantTextForPlayback(
      s.pendingAssistantTexts,
      text,
      event.turnId,
      event.orchestrationId,
      event.messageId,
    );
    deps.sessionStore?.markTextReceived(
      event.orchestrationId,
      event.turnId,
      text,
      event.messageId,
      "replace",
    );
  }
  s.lastError = "";
  s.statusMessage = text ? "已收到文本回复，等待同步播放。" : "已收到空文本回复。";
}

async function applyOutputAudio(
  deps: InboundDispatchDeps,
  event: Extract<InboundAdapterEvent, { kind: "output_audio" }>,
): Promise<void> {
  const s = deps.state;
  s.currentTurnId = event.turnId;
  s.currentOrchestrationId = event.orchestrationId;
  if (event.text) {
    const existingText = deps.sessionStore
      ?.ensureSegment(event.orchestrationId, event.turnId, event.messageId)
      .text.content;
    if (!existingText) {
      deps.queuePendingAssistantTextForPlayback(
        s.pendingAssistantTexts,
        event.text,
        event.turnId,
        event.orchestrationId,
        event.messageId,
      );
      deps.sessionStore?.markTextReceived(
        event.orchestrationId,
        event.turnId,
        event.text,
        event.messageId,
        "replace",
      );
    }
  }

  if (!event.audioUrl) {
    s.statusMessage = "收到音频回复占位，未提供可播放地址。";
    deps.pushHistory("system", s.statusMessage);
    deps.markAudioPlaybackTerminal(
      "failed",
      event.turnId,
      event.orchestrationId,
      "missing_audio_url",
      event.messageId,
    );
    return;
  }

  const resolvedUrl = deps.rewriteHttpUrl(event.audioUrl);
  deps.queuePendingAudioForPlayback(
    s.pendingAudios,
    resolvedUrl,
    event.turnId,
    event.orchestrationId,
    event.messageId,
  );
  deps.sessionStore?.markAudioReceived(event.orchestrationId, event.turnId, resolvedUrl, event.messageId);
}

function applyOutputImage(
  deps: InboundDispatchDeps,
  envelope: ProtocolEnvelope<OutputImagePayload>,
): void {
  const s = deps.state;
  s.lastImageCount = envelope.payload.images.length;
  s.statusMessage = `收到 ${envelope.payload.images.length} 张图片回复。`;
  deps.pushHistory("system", s.statusMessage);
}

function applyOutputTranscription(
  deps: InboundDispatchDeps,
  envelope: ProtocolEnvelope<OutputTranscriptionPayload>,
): void {
  const s = deps.state;
  const text = envelope.payload.text.trim();
  if (text) {
    s.lastTranscription = text;
    s.statusMessage = "已收到语音转写。";
    deps.pushHistory("transcription", text);
  }
}

function applyTurnFinished(
  deps: InboundDispatchDeps,
  event: Extract<InboundAdapterEvent, { kind: "turn_finished" }>,
): void {
  const s = deps.state;
  s.turnFinishedTurnId = event.turnId;
  s.turnFinishedOrchestrationId = event.orchestrationId;
  s.turnFinishedSuccess = event.success;
  s.turnFinishedReason = event.reason;
  deps.sessionStore?.markTurnFinished(
    s.turnFinishedOrchestrationId,
    s.turnFinishedTurnId,
    s.turnFinishedSuccess,
    s.turnFinishedReason,
  );

  if (event.success) {
    s.statusMessage = "本轮对话已完成。";
    s.lastError = "";
    deps.pushHistory("system", s.statusMessage);
    return;
  }

  s.statusMessage = event.reason
    ? `本轮结束：${event.reason}`
    : "本轮对话未正常完成。";
  deps.pushHistory("system", s.statusMessage);
}

function applyControlError(
  deps: InboundDispatchDeps,
  envelope: ProtocolEnvelope<ControlErrorPayload>,
): void {
  const s = deps.state;
  s.lastError = envelope.payload.message;
  s.statusMessage = envelope.payload.message;
  deps.pushHistory("error", envelope.payload.message);
}

function applySemanticAxisProfileSaved(
  deps: InboundDispatchDeps,
  envelope: ProtocolEnvelope<SystemSemanticAxisProfileSavedPayload>,
): void {
  const s = deps.state;
  s.latestSemanticAxisProfileSaveResult = {
    requestId: envelope.payload.request_id,
    ok: true,
    modelName: envelope.payload.model_name,
    profileId: envelope.payload.profile_id,
    revision: envelope.payload.revision,
    sourceHash: envelope.payload.source_hash,
    savedAt: envelope.payload.saved_at,
    receivedAt: new Date().toISOString(),
  };
  s.lastError = "";
  s.statusMessage = `主轴配置已保存到 revision ${envelope.payload.revision}。`;
  deps.pushHistory("system", s.statusMessage);
}

function applySemanticAxisProfileSaveFailed(
  deps: InboundDispatchDeps,
  envelope: ProtocolEnvelope<SystemSemanticAxisProfileSaveFailedPayload>,
): void {
  const s = deps.state;
  s.latestSemanticAxisProfileSaveResult = {
    requestId: envelope.payload.request_id,
    ok: false,
    modelName: envelope.payload.model_name,
    profileId: envelope.payload.profile_id,
    expectedRevision: envelope.payload.expected_revision,
    errorCode: envelope.payload.error_code,
    message: envelope.payload.message,
    receivedAt: new Date().toISOString(),
  };
  s.lastError = envelope.payload.message;
  s.statusMessage = `主轴配置保存失败：${envelope.payload.message}`;
  deps.pushHistory("error", s.statusMessage);
}

function reportProtocolError(
  deps: InboundDispatchDeps,
  key: string,
  message: string,
  envelope?: ProtocolEnvelope<unknown>,
): void {
  const s = deps.state;
  s.lastError = message;
  s.statusMessage = message;
  if (!deps.reportedProtocolWarnings.has(key)) {
    deps.pushHistory("error", message);
    deps.reportedProtocolWarnings.add(key);
  }
  console.warn("[Connection] protocol error.", message, envelope);
}

function reportUnhandledInboundEnvelope(
  deps: InboundDispatchDeps,
  envelope: ProtocolEnvelope<unknown>,
): void {
  const key = `type:${envelope.type}`;
  const message = `收到未接入的协议消息 ${envelope.type}。`;
  deps.state.lastError = "";
  deps.state.statusMessage = message;
  if (!deps.reportedProtocolWarnings.has(key)) {
    deps.pushHistory("system", message);
    deps.reportedProtocolWarnings.add(key);
  }
  console.warn("[Connection] unhandled inbound protocol message.", envelope.type, envelope);
}

// ── Main dispatch ──────────────────────────────────────────────────

export async function dispatchInboundEvent(
  deps: InboundDispatchDeps,
  event: InboundAdapterEvent,
): Promise<void> {
  const s = deps.state;
  switch (event.kind) {
    case "server_info":
      applyServerInfoMessage(deps, event.envelope);
      return;
    case "model_sync":
      deps.modelSyncAdapter?.applyUnknownMessage(
        deps.rewriteModelSyncEnvelope(event.envelope),
      );
      s.statusMessage = "模型能力已同步。";
      deps.pushHistory("system", s.statusMessage);
      return;
    case "semantic_axis_profile_saved":
      applySemanticAxisProfileSaved(deps, event.envelope);
      return;
    case "semantic_axis_profile_save_failed":
      applySemanticAxisProfileSaveFailed(deps, event.envelope);
      return;
    case "motion_tuning_samples_state":
      deps.motionTuningAdapter?.applyMotionTuningSamplesState(event.envelope);
      return;
    case "history_list":
      deps.historyAdapter?.applyHistoryList(event.envelope);
      return;
    case "history_created":
      deps.historyAdapter?.applyHistoryCreated(event.envelope);
      return;
    case "history_data":
      deps.historyAdapter?.applyHistoryData(event.envelope);
      return;
    case "history_deleted":
      deps.historyAdapter?.applyHistoryDeleted(event.envelope);
      return;
    case "output_text":
      applyOutputText(deps, event);
      return;
    case "output_audio":
      await applyOutputAudio(deps, event);
      return;
    case "output_image":
      applyOutputImage(deps, event.envelope);
      return;
    case "output_transcription":
      applyOutputTranscription(deps, event.envelope);
      return;
    case "turn_started":
      s.currentTurnId = event.turnId;
      s.currentOrchestrationId = event.orchestrationId;
      deps.sessionStore?.setActiveSession(s.currentOrchestrationId, s.currentTurnId);
      deps.sessionStore?.markTurnStarted(s.currentOrchestrationId, s.currentTurnId);
      deps.resetAudioPlaybackTerminal();
      s.pendingAssistantTexts.clear();
      s.pendingAudios.clear();
      s.turnFinishedTurnId = null;
      s.turnFinishedOrchestrationId = null;
      s.turnFinishedSuccess = true;
      s.turnFinishedReason = "";
      s.statusMessage = "后端正在处理这一轮对话。";
      deps.pushHistory("system", s.statusMessage);
      return;
    case "turn_finished":
      applyTurnFinished(deps, event);
      return;
    case "interrupt":
      deps.stopAudioPlayback();
      deps.resetAudioPlaybackTerminal();
      deps.sessionStore?.markInterrupt(event.orchestrationId, event.turnId);
      s.currentTurnId = null;
      s.currentOrchestrationId = null;
      s.statusMessage = "当前轮次已中断。";
      deps.pushHistory("system", s.statusMessage);
      return;
    case "start_mic":
      s.micRequested = true;
      s.statusMessage = "后端已请求启动麦克风，准备自动收音。";
      deps.pushHistory("system", s.statusMessage);
      void deps.startMicrophoneCapture();
      return;
    case "synth_finished":
      deps.sessionStore?.markSynthFinished(event.orchestrationId, event.turnId);
      deps.markMissingAudiosForTurn(
        event.turnId,
        event.orchestrationId,
        "synth_finished_without_audio_playback",
      );
      s.statusMessage =
        s.isPlayingAudio || deps.hasPendingAudioForTurn(event.turnId, event.orchestrationId)
          ? "语音已准备同步播放。"
          : "语音合成已完成。";
      deps.pushHistory("system", s.statusMessage);
      return;
    case "control_error":
      applyControlError(deps, event.envelope);
      return;
    case "protocol_error":
      reportProtocolError(
        deps,
        event.warningKey,
        event.error.message,
        event.envelope,
      );
      return;
    case "engine_motion_payload": {
      const activeAudioSegment = deps.findActiveAudioSegment();
      const result = deps.applyInboundMotionPayload({
        state: deps.state,
        activeAudioTurnId: activeAudioSegment?.turnId ?? null,
        activeAudioOrchestrationId: activeAudioSegment?.orchestrationId ?? null,
        pushHistory: deps.pushHistory,
      }, event.envelope);
      if (!result.accepted) {
        return;
      }
      const normalized = deps.normalizeMotionPayload(result.rawPlan);
      if (normalized.ok) {
        deps.sessionStore?.markMotionReceived(
          event.orchestrationId,
          event.turnId,
          normalized.payload,
          event.messageId,
        );
      }
      return;
    }
    case "unhandled":
      reportUnhandledInboundEnvelope(deps, event.envelope);
      return;
  }
}
