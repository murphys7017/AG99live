import { reactive, readonly } from "vue";
import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopHistoryEntry,
  DesktopMotionTuningSamplesStatus,
  DesktopSemanticAxisProfileSaveResult,
  DesktopMotionTuningSample,
} from "../types/desktop";
import type {
  ControlErrorPayload,
  ControlTurnFinishedPayload,
  OutputAudioPayload,
  OutputImagePayload,
  OutputTextPayload,
  OutputTranscriptionPayload,
  ProtocolEnvelope,
  SystemSemanticAxisProfileSavePayload,
  SystemSemanticAxisProfileSavedPayload,
  SystemSemanticAxisProfileSaveFailedPayload,
  SystemModelSyncPayload,
  SystemServerInfoPayload,
} from "../types/protocol";
import {
  SCHEMA_MOTION_INTENT_V2,
  SCHEMA_PARAMETER_PLAN_V2,
} from "../types/protocol.js";
import { applyInboundMotionPayload } from "../adapter-connection/inboundMotion.js";
import {
  clearPlaybackGroupContext as clearPlaybackGroup,
  interruptCurrentTurn as sendInterrupt,
  sendMotionPayloadPreview as sendMotionPreview,
  sendPlaybackFinished as sendPlaybackFinishedAction,
  sendSemanticAxisProfileSave as sendProfileSave,
  sendText as sendTextAction,
} from "../adapter-connection/outboundActions.js";
import {
  playAudioAndAcknowledge as playAudioAction,
  stopAudioPlayback as stopAudioAction,
} from "../adapter-connection/audioPlaybackActions.js";
import { useAdapterMotionTuning } from "./useAdapterMotionTuning.js";
import {
  rewriteHttpUrl as rewriteHttpUrlWithActiveHost,
  rewriteModelSyncEnvelope as rewriteModelSyncEnvelopeWithActiveHost,
  rewriteSocketUrl as rewriteSocketUrlWithActiveHost,
} from "../adapter-connection/modelSyncRewrite.js";
import {
  isMicrophoneCaptureRuntimeActive,
  startMicrophoneCaptureRuntime,
  stopMicrophoneCaptureRuntime,
  type MicrophoneAudioChunk,
} from "../adapter-connection/microphoneCapture.js";
import {
  startAudioPlayback,
  stopAudioPlaybackRuntime,
} from "../adapter-connection/audioPlayback.js";
import {
  buildConnectFailureMessage,
  buildConnectionCandidates,
  DEFAULT_ADAPTER_ADDRESS,
  formatAddressHost,
  normalizeWsAddress,
} from "../adapter-connection/address.js";
import {
  buildMessageEnvelope as buildProtocolMessageEnvelope,
  createMessageId,
  PROTOCOL_VERSION,
} from "../adapter-connection/envelope.js";
import {
  loadDesktopScreenshotOnSendEnabled,
  loadStoredAdapterAddress,
  normalizeAdapterAddressSetting,
  saveDesktopScreenshotOnSendEnabled,
  saveStoredAdapterAddress,
} from "../adapter-connection/preferences.js";
import { parseInboundEnvelope } from "../adapter-connection/inboundProtocol.js";
import {
  mapInboundEnvelopeToEvent,
  type InboundAdapterEvent,
  type InboundEventMappingContext,
} from "../adapter-connection/inboundEvents.js";
import {
  matchesPlaybackGroup,
  queueAssistantTextForPlayback as queuePendingAssistantTextForPlayback,
  queueAudioForPlayback as queuePendingAudioForPlayback,
  type PendingAssistantTextItem,
  type PendingAudioItem,
} from "../adapter-connection/playbackReleaseQueue.js";
import { useModelSync } from "./useModelSync.js";
import { useAdapterHistory } from "./useAdapterHistory.js";
import { normalizeMotionPayload } from "../model-engine/normalize.js";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore.js";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
type AudioPlaybackTerminalState = "idle" | "completed" | "failed" | "not_requested";

const MAX_MIC_SOCKET_BUFFERED_AMOUNT = 512 * 1024;
const state = reactive({
  address: loadStoredAdapterAddress(),
  desktopScreenshotOnSendEnabled: loadDesktopScreenshotOnSendEnabled(),
  sessionId: "",
  status: "disconnected" as ConnectionStatus,
  statusMessage: "尚未连接适配器。",
  serverInfo: null as SystemServerInfoPayload | null,
  activeWsAddress: "",
  lastError: "",
  lastAssistantText: "",
  lastTranscription: "",
  lastImageCount: 0,
  currentTurnId: null as string | null,
  currentOrchestrationId: null as string | null,
  micRequested: false,
  micCapturing: false,
  isPlayingAudio: false,
  historyEntries: [] as DesktopHistoryEntry[],
  backendHistorySummaries: [] as DesktopBackendHistorySummary[],
  backendHistoryEntries: [] as DesktopBackendHistoryMessage[],
  activeBackendHistoryUid: "",
  backendHistoryLoading: false,
  backendHistoryStatusMessage: "等待历史窗口请求后端历史。",
  inboundMotionPlan: null as unknown | null,
  inboundMotionPlanTurnId: null as string | null,
  inboundMotionPlanOrchestrationId: null as string | null,
  inboundMotionPlanReceivedAtMs: 0,
  pendingAssistantTexts: new Map<string, PendingAssistantTextItem>(),
  pendingAudios: new Map<string, PendingAudioItem>(),
  audioPlaybackStartedTurnId: null as string | null,
  audioPlaybackStartedOrchestrationId: null as string | null,
  audioPlaybackStartedMessageId: null as string | null,
  audioPlaybackStartedAtMs: 0,
  audioPlaybackDurationMs: null as number | null,
  audioPlaybackTerminalState: "idle" as AudioPlaybackTerminalState,
  audioPlaybackTerminalTurnId: null as string | null,
  audioPlaybackTerminalOrchestrationId: null as string | null,
  audioPlaybackTerminalReason: "",
  assistantTextDeliveryTurnId: null as string | null,
  assistantTextDeliveryOrchestrationId: null as string | null,
  turnFinishedTurnId: null as string | null,
  turnFinishedOrchestrationId: null as string | null,
  turnFinishedSuccess: true,
  turnFinishedReason: "",
  latestSemanticAxisProfileSaveResult: null as DesktopSemanticAxisProfileSaveResult | null,
  motionTuningSamples: [] as DesktopMotionTuningSample[],
  motionTuningSamplesStatus: {
    rootError: "",
    loadError: "",
    diagnostics: [],
  } as DesktopMotionTuningSamplesStatus,
});

let socket: WebSocket | null = null;
let manualClose = false;
let initializePromise: Promise<void> | null = null;
let connectAttemptSerial = 0;
const assistantHistoryKeys: string[] = [];
const assistantHistoryKeySet = new Set<string>();
const reportedProtocolWarnings = new Set<string>();

let historyAdapter: ReturnType<typeof useAdapterHistory> | null = null;
let motionTuningAdapter: ReturnType<typeof useAdapterMotionTuning> | null = null;
let modelSyncAdapter: ReturnType<typeof useModelSync> | null = null;
let sessionStore: ReturnType<typeof useTurnPlaybackSessionStore> | undefined;

function buildMessageEnvelope<TPayload>(
  type: string,
  payload: TPayload,
  turnId: string | null = null,
  orchestrationId: string | null = state.currentOrchestrationId,
): ProtocolEnvelope<TPayload> {
  return buildProtocolMessageEnvelope(
    type,
    payload,
    state.sessionId,
    turnId,
    orchestrationId,
  );
}

const outboundCtx = {
  get state() {
    return state;
  },
  getSocket: () => socket,
  buildEnvelope: buildMessageEnvelope as (typeof buildMessageEnvelope),
  pushHistory: pushHistory as (role: string, text: string) => void,
  stopAudio: () => stopAudioPlayback(),
  resetAudioPlaybackTerminal,
  createMessageId,
};

const audioPlaybackCtx = {
  get state() {
    return state;
  },
  startAudio: startAudioPlayback,
  stopAudioRuntime: stopAudioPlaybackRuntime,
  pushHistory: pushHistory as (role: string, text: string) => void,
  markTerminal: markAudioPlaybackTerminal,
  resetTerminal: resetAudioPlaybackTerminal,
  get sessionStore() {
    return sessionStore
      ? {
          markAudioStarted: (
            orchestrationId: string | null,
            turnId: string | null,
            messageId: string,
            startedAtMs?: number | null,
            durationMs?: number | null,
          ) => sessionStore?.markAudioStarted(
            orchestrationId,
            turnId,
            messageId,
            startedAtMs,
            durationMs,
          ),
        }
      : undefined;
  },
};

function markAudioPlaybackTerminal(
  terminalState: Exclude<AudioPlaybackTerminalState, "idle">,
  turnId: string | null,
  orchestrationId: string | null,
  reason = "",
  messageId: string | null = null,
): void {
  state.audioPlaybackTerminalState = terminalState;
  state.audioPlaybackTerminalTurnId = turnId;
  state.audioPlaybackTerminalOrchestrationId = orchestrationId;
  state.audioPlaybackTerminalReason = reason;

  if (!messageId) {
    return;
  }

  const sessionTerminal: "completed" | "failed" | "absent" =
    terminalState === "not_requested" ? "absent" : terminalState;
  sessionStore?.markAudioTerminal(
    orchestrationId,
    turnId,
    sessionTerminal,
    messageId,
    reason,
  );
}

function resetAudioPlaybackTerminal(): void {
  state.audioPlaybackTerminalState = "idle";
  state.audioPlaybackTerminalTurnId = null;
  state.audioPlaybackTerminalOrchestrationId = null;
  state.audioPlaybackTerminalReason = "";
}

function sendMicrophoneAudioChunk(chunk: MicrophoneAudioChunk): void {
  if (
    !socket
    || socket.readyState !== WebSocket.OPEN
    || socket.bufferedAmount > MAX_MIC_SOCKET_BUFFERED_AMOUNT
  ) {
    return;
  }

  if (!chunk.audio.length) {
    return;
  }

  socket.send(
    JSON.stringify(
      buildMessageEnvelope("input.raw_audio_data", {
        audio: chunk.audio,
        sample_rate: chunk.sampleRate,
        channels: chunk.channels,
      }),
    ),
  );
}

function persistAddress(nextAddress: string): void {
  const normalizedAddress = normalizeAdapterAddressSetting(nextAddress);
  state.address = normalizedAddress;
  saveStoredAdapterAddress(normalizedAddress);
}

function setDesktopScreenshotOnSendEnabled(enabled: boolean): void {
  state.desktopScreenshotOnSendEnabled = enabled;
  saveDesktopScreenshotOnSendEnabled(enabled);
}

function setAddress(nextAddress: string): void {
  persistAddress(nextAddress);
}

async function initialize(): Promise<void> {
  if (!initializePromise) {
    initializePromise = Promise.resolve().then(() => {
      const storedAddress = loadStoredAdapterAddress();
      if (storedAddress.trim()) {
        persistAddress(storedAddress);
      }
    });
  }

  await initializePromise;
}

function connect(): void {
  disconnectInternal(false);

  let candidates: string[] = [normalizeWsAddress(DEFAULT_ADAPTER_ADDRESS)];
  try {
    candidates = buildConnectionCandidates(state.address);
  } catch (error) {
    state.status = "error";
    state.lastError = error instanceof Error ? error.message : "连接地址格式无效。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return;
  }

  state.status = "connecting";
  state.statusMessage = "正在连接适配器...";
  state.lastError = "";
  pushHistory("system", `开始连接 ${candidates[0]}`);

  const attemptSerial = ++connectAttemptSerial;
  openConnectionCandidate(candidates, 0, attemptSerial);
}

function disconnect(): void {
  const hadActiveSocket = Boolean(socket);
  disconnectInternal(true);
  state.status = "disconnected";
  state.statusMessage = "已断开适配器连接。";
  if (!hadActiveSocket) {
    pushHistory("system", state.statusMessage);
  }
}

function disconnectInternal(markManualClose: boolean): void {
  manualClose = markManualClose;
  connectAttemptSerial += 1;
  void stopMicrophoneCapture(markManualClose ? "manual_disconnect" : "connection_reset");
  stopAudioPlayback();
  if (socket) {
    const currentSocket = socket;
    socket = null;
    currentSocket.close();
  }
}

function openConnectionCandidate(
  candidates: string[],
  index: number,
  attemptSerial: number,
): void {
  const targetAddress = candidates[index];
  const total = candidates.length;

  if (index > 0) {
    pushHistory("system", `尝试候选地址 ${targetAddress}`);
  }

  state.status = "connecting";
  state.statusMessage =
    total > 1
      ? `正在连接适配器 (${index + 1}/${total})...`
      : "正在连接适配器...";

  const nextSocket = new WebSocket(targetAddress);
  let opened = false;
  socket = nextSocket;

  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket || attemptSerial !== connectAttemptSerial) {
      nextSocket.close();
      return;
    }

    opened = true;
    persistAddress(state.address);
    state.activeWsAddress = targetAddress;
    state.status = "connected";
    state.statusMessage = "连接已建立，等待后端同步。";
    state.lastError = "";
    pushHistory("system", `已连接 ${targetAddress}`);
  });

  nextSocket.addEventListener("message", (event) => {
    handleSocketMessage(event.data as string).catch((error) => {
      console.warn("[useAdapterConnection] unhandled error in message handler:", error);
    });
  });

  nextSocket.addEventListener("error", () => {
    if (socket !== nextSocket || attemptSerial !== connectAttemptSerial) {
      return;
    }

    if (!opened && index < candidates.length - 1) {
      state.statusMessage = `连接 ${formatAddressHost(targetAddress)} 失败，尝试下一个地址...`;
      socket = null;
      nextSocket.close();
      openConnectionCandidate(candidates, index + 1, attemptSerial);
      return;
    }

    state.status = "error";
    state.lastError = opened
      ? "WebSocket 连接异常，请检查地址和 AstrBot 插件状态。"
      : buildConnectFailureMessage(candidates);
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
  });

  nextSocket.addEventListener("close", () => {
    const isCurrentSocket = socket === nextSocket;
    const shouldHandleClose = isCurrentSocket || (socket === null && manualClose);
    if (!shouldHandleClose) {
      return;
    }

    if (isCurrentSocket) {
      socket = null;
    }

    if (
      !opened
      && !manualClose
      && attemptSerial === connectAttemptSerial
      && index < candidates.length - 1
    ) {
      openConnectionCandidate(candidates, index + 1, attemptSerial);
      return;
    }

    resetConnectionRuntimeState();

    if (manualClose) {
      state.status = "disconnected";
      state.statusMessage = "已断开适配器连接。";
      return;
    }

    if (!opened) {
      if (state.status !== "error") {
        state.status = "error";
        state.lastError = buildConnectFailureMessage(candidates);
        state.statusMessage = state.lastError;
        pushHistory("error", state.lastError);
      }
      return;
    }

    if (state.status !== "error") {
      state.status = "disconnected";
      state.statusMessage = "连接已关闭。";
      pushHistory("system", state.statusMessage);
    }
  });
}

function resetConnectionRuntimeState(): void {
  void stopMicrophoneCapture("connection_closed");
  stopAudioPlayback();
  historyAdapter?.resetHistoryState();
  state.isPlayingAudio = false;
  state.currentTurnId = null;
  state.currentOrchestrationId = null;
  state.serverInfo = null;
  state.activeWsAddress = "";
  state.sessionId = "";
  state.micRequested = false;
  state.micCapturing = false;
  state.inboundMotionPlan = null;
  state.inboundMotionPlanTurnId = null;
  state.inboundMotionPlanOrchestrationId = null;
  state.inboundMotionPlanReceivedAtMs = 0;
  state.pendingAssistantTexts.clear();
  state.pendingAudios.clear();
  state.audioPlaybackStartedTurnId = null;
  state.audioPlaybackStartedOrchestrationId = null;
  state.audioPlaybackStartedMessageId = null;
  state.audioPlaybackStartedAtMs = 0;
  state.audioPlaybackDurationMs = null;
  resetAudioPlaybackTerminal();
  state.assistantTextDeliveryTurnId = null;
  state.assistantTextDeliveryOrchestrationId = null;
  state.turnFinishedTurnId = null;
  state.turnFinishedOrchestrationId = null;
  state.turnFinishedSuccess = true;
  state.turnFinishedReason = "";
  state.latestSemanticAxisProfileSaveResult = null;
  modelSyncAdapter?.resetModelSyncState();
}

async function toggleMicrophoneCapture(): Promise<boolean> {
  if (state.micCapturing) {
    return stopMicrophoneCapture("manual_stop");
  }

  return startMicrophoneCapture();
}

async function startMicrophoneCapture(): Promise<boolean> {
  if (state.micCapturing) {
    return true;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，无法启动麦克风。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  state.statusMessage = "正在请求麦克风权限...";

  try {
    await startMicrophoneCaptureRuntime({
      onChunk: (chunk) => {
        sendMicrophoneAudioChunk(chunk);
      },
      onDeviceEnded: () => {
        void stopMicrophoneCapture("device_ended");
      },
    });

    state.micCapturing = true;
    state.micRequested = true;
    state.lastError = "";
    state.statusMessage = "麦克风已开启，正在自动检测说话。";
    pushHistory("system", state.statusMessage);
    return true;
  } catch (error) {
    state.micCapturing = false;
    state.lastError =
      error instanceof Error ? error.message : "麦克风启动失败。";
    state.statusMessage = `麦克风启动失败：${state.lastError}`;
    pushHistory("error", state.statusMessage);
    return false;
  }
}

async function stopMicrophoneCapture(reason = "manual_stop"): Promise<boolean> {
  if (!isMicrophoneCaptureRuntimeActive()) {
    state.micCapturing = false;
    if (reason === "manual_stop") {
      state.micRequested = false;
    }
    return false;
  }

  state.micCapturing = false;
  if (reason === "manual_stop" || reason === "device_ended") {
    state.micRequested = false;
  }

  await stopMicrophoneCaptureRuntime();

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify(
        buildMessageEnvelope("input.mic_audio_end", {
          reason,
        }),
      ),
    );
  }

  state.statusMessage =
    reason === "manual_stop"
      ? "麦克风已关闭。"
      : "麦克风采集已停止。";
  if (reason !== "connection_closed" && reason !== "connection_reset") {
    pushHistory("system", state.statusMessage);
  }
  return true;
}

async function handleSocketMessage(rawData: string): Promise<void> {
  const parsed = parseInboundEnvelope(rawData);
  if (!parsed.ok) {
    if (parsed.code === "version_mismatch") {
      reportProtocolError(
        parsed.warningKey ?? "version:empty",
        parsed.message,
        parsed.envelope,
      );
      return;
    }

    state.lastError = parsed.message;
    state.statusMessage = parsed.message;
    pushHistory("error", parsed.message);
    return;
  }

  const envelope = parsed.envelope;
  if (typeof envelope.session_id === "string" && envelope.session_id.trim()) {
    state.sessionId = envelope.session_id.trim();
  }

  const event = mapInboundEnvelopeToEvent(envelope, buildInboundEventContext());
  await dispatchInboundEvent(event);
}

function buildInboundEventContext(): InboundEventMappingContext {
  return {
    currentTurnId: state.currentTurnId,
    currentOrchestrationId: state.currentOrchestrationId,
    audioPlaybackStartedTurnId: state.audioPlaybackStartedTurnId,
    audioPlaybackStartedOrchestrationId: state.audioPlaybackStartedOrchestrationId,
  };
}

async function dispatchInboundEvent(
  event: InboundAdapterEvent,
): Promise<void> {
  switch (event.kind) {
    case "server_info":
      applyServerInfoMessage(event.envelope);
      return;
    case "model_sync":
      modelSyncAdapter?.applyUnknownMessage(
        rewriteModelSyncEnvelope(event.envelope),
      );
      state.statusMessage = "模型能力已同步。";
      pushHistory("system", state.statusMessage);
      return;
    case "semantic_axis_profile_saved":
      applySemanticAxisProfileSaved(event.envelope);
      return;
    case "semantic_axis_profile_save_failed":
      applySemanticAxisProfileSaveFailed(event.envelope);
      return;
    case "motion_tuning_samples_state":
      motionTuningAdapter?.applyMotionTuningSamplesState(event.envelope);
      return;
    case "history_list":
      historyAdapter?.applyHistoryList(event.envelope);
      return;
    case "history_created":
      historyAdapter?.applyHistoryCreated(event.envelope);
      return;
    case "history_data":
      historyAdapter?.applyHistoryData(event.envelope);
      return;
    case "history_deleted":
      historyAdapter?.applyHistoryDeleted(event.envelope);
      return;
    case "output_text":
      applyOutputText(event);
      return;
    case "output_audio":
      await applyOutputAudio(event);
      return;
    case "output_image":
      applyOutputImage(event.envelope);
      return;
    case "output_transcription":
      applyOutputTranscription(event.envelope);
      return;
    case "turn_started":
      state.currentTurnId = event.turnId;
      state.currentOrchestrationId = event.orchestrationId;
      sessionStore?.setActiveSession(state.currentOrchestrationId, state.currentTurnId);
      sessionStore?.markTurnStarted(state.currentOrchestrationId, state.currentTurnId);
      resetAudioPlaybackTerminal();
      state.pendingAssistantTexts.clear();
      state.pendingAudios.clear();
      state.assistantTextDeliveryTurnId = null;
      state.assistantTextDeliveryOrchestrationId = null;
      state.turnFinishedTurnId = null;
      state.turnFinishedOrchestrationId = null;
      state.turnFinishedSuccess = true;
      state.turnFinishedReason = "";
      state.statusMessage = "后端正在处理这一轮对话。";
      pushHistory("system", state.statusMessage);
      return;
    case "turn_finished":
      applyTurnFinished(event);
      return;
    case "interrupt":
      stopAudioPlayback();
      resetAudioPlaybackTerminal();
      sessionStore?.markInterrupt(event.orchestrationId, event.turnId);
      state.currentTurnId = null;
      state.currentOrchestrationId = null;
      state.statusMessage = "当前轮次已中断。";
      pushHistory("system", state.statusMessage);
      return;
    case "start_mic":
      state.micRequested = true;
      state.statusMessage = "后端已请求启动麦克风，准备自动收音。";
      pushHistory("system", state.statusMessage);
      void startMicrophoneCapture();
      return;
    case "synth_finished":
      sessionStore?.markSynthFinished(event.orchestrationId, event.turnId);
      markMissingAudiosForTurn(
        event.turnId,
        event.orchestrationId,
        "synth_finished_without_audio_playback",
      );
      state.statusMessage =
        state.isPlayingAudio || hasPendingAudioForTurn(event.turnId, event.orchestrationId)
          ? "语音已准备同步播放。"
          : "语音合成已完成。";
      pushHistory("system", state.statusMessage);
      return;
    case "control_error":
      applyControlError(event.envelope);
      return;
    case "protocol_error":
      reportProtocolError(
        event.warningKey,
        event.error.message,
        event.envelope,
      );
      return;
    case "engine_motion_payload": {
      const result = applyInboundMotionPayload({ state, pushHistory }, event.envelope);
      if (!result.accepted) {
        return;
      }
      const normalized = normalizeMotionPayload(result.rawPlan);
      if (normalized.ok) {
        sessionStore?.markMotionReceived(
          event.orchestrationId,
          event.turnId,
          normalized.payload,
          event.messageId,
        );
      }
      return;
    }
    case "unhandled":
      reportUnhandledInboundEnvelope(event.envelope);
      return;
  }
}

function applyServerInfoMessage(envelope: ProtocolEnvelope<SystemServerInfoPayload>): void {
  state.serverInfo = {
    ...envelope.payload,
    ws_url: rewriteSocketUrl(envelope.payload.ws_url),
    http_base_url: rewriteHttpUrl(envelope.payload.http_base_url),
  };
  state.micRequested = state.serverInfo.auto_start_mic;
  state.statusMessage = "适配器已连接，等待模型同步。";
  pushHistory("system", "收到后端运行信息。");
  if (state.serverInfo.auto_start_mic) {
    void startMicrophoneCapture();
  }
}

function applyOutputText(
  event: Extract<InboundAdapterEvent, { kind: "output_text" }>,
): void {
  state.currentTurnId = event.turnId;
  state.currentOrchestrationId = event.orchestrationId;
  const text = event.text;
  if (text) {
    queueAssistantTextForPlayback(
      text,
      event.turnId,
      event.orchestrationId,
      event.messageId,
    );
    sessionStore?.markTextReceived(
      event.orchestrationId,
      event.turnId,
      text,
      event.messageId,
      "replace",
    );
  }
  state.lastError = "";
  state.statusMessage = text ? "已收到文本回复，等待同步播放。" : "已收到空文本回复。";
}

async function applyOutputAudio(
  event: Extract<InboundAdapterEvent, { kind: "output_audio" }>,
): Promise<void> {
  state.currentTurnId = event.turnId;
  state.currentOrchestrationId = event.orchestrationId;
  if (event.text) {
    const existingText = sessionStore
      ?.ensureSegment(event.orchestrationId, event.turnId, event.messageId)
      .text.content;
    if (!existingText) {
      queueAssistantTextForPlayback(
        event.text,
        event.turnId,
        event.orchestrationId,
        event.messageId,
      );
      sessionStore?.markTextReceived(
        event.orchestrationId,
        event.turnId,
        event.text,
        event.messageId,
        "replace",
      );
    }
  }

  if (!event.audioUrl) {
    state.statusMessage = "收到音频回复占位，未提供可播放地址。";
    pushHistory("system", state.statusMessage);
    markAudioPlaybackTerminal(
      "failed",
      event.turnId,
      event.orchestrationId,
      "missing_audio_url",
      event.messageId,
    );
    return;
  }

  const resolvedUrl = rewriteHttpUrl(event.audioUrl);
  queueAudioForPlayback(
    resolvedUrl,
    event.turnId,
    event.orchestrationId,
    event.messageId,
  );
  sessionStore?.markAudioReceived(event.orchestrationId, event.turnId, resolvedUrl, event.messageId);
}

function applyOutputImage(envelope: ProtocolEnvelope<OutputImagePayload>): void {
  state.lastImageCount = envelope.payload.images.length;
  state.statusMessage = `收到 ${envelope.payload.images.length} 张图片回复。`;
  pushHistory("system", state.statusMessage);
}

function applyOutputTranscription(
  envelope: ProtocolEnvelope<OutputTranscriptionPayload>,
): void {
  const text = envelope.payload.text.trim();
  if (text) {
    state.lastTranscription = text;
    state.statusMessage = "已收到语音转写。";
    pushHistory("transcription", text);
  }
}

function applyTurnFinished(
  event: Extract<InboundAdapterEvent, { kind: "turn_finished" }>,
): void {
  state.turnFinishedTurnId = event.turnId;
  state.turnFinishedOrchestrationId = event.orchestrationId;
  state.turnFinishedSuccess = event.success;
  state.turnFinishedReason = event.reason;
  sessionStore?.markTurnFinished(
    state.turnFinishedOrchestrationId,
    state.turnFinishedTurnId,
    state.turnFinishedSuccess,
    state.turnFinishedReason,
  );

  if (event.success) {
    state.statusMessage = "本轮对话已完成。";
    state.lastError = "";
    pushHistory("system", state.statusMessage);
    return;
  }

  state.statusMessage = event.reason
    ? `本轮结束：${event.reason}`
    : "本轮对话未正常完成。";
  pushHistory("system", state.statusMessage);
}

function applyControlError(envelope: ProtocolEnvelope<ControlErrorPayload>): void {
  state.lastError = envelope.payload.message;
  state.statusMessage = envelope.payload.message;
  pushHistory("error", envelope.payload.message);
}

function applySemanticAxisProfileSaved(
  envelope: ProtocolEnvelope<SystemSemanticAxisProfileSavedPayload>,
): void {
  state.latestSemanticAxisProfileSaveResult = {
    requestId: envelope.payload.request_id,
    ok: true,
    modelName: envelope.payload.model_name,
    profileId: envelope.payload.profile_id,
    revision: envelope.payload.revision,
    sourceHash: envelope.payload.source_hash,
    savedAt: envelope.payload.saved_at,
    receivedAt: new Date().toISOString(),
  };
  state.lastError = "";
  state.statusMessage = `主轴配置已保存到 revision ${envelope.payload.revision}。`;
  pushHistory("system", state.statusMessage);
}

function applySemanticAxisProfileSaveFailed(
  envelope: ProtocolEnvelope<SystemSemanticAxisProfileSaveFailedPayload>,
): void {
  state.latestSemanticAxisProfileSaveResult = {
    requestId: envelope.payload.request_id,
    ok: false,
    modelName: envelope.payload.model_name,
    profileId: envelope.payload.profile_id,
    expectedRevision: envelope.payload.expected_revision,
    errorCode: envelope.payload.error_code,
    message: envelope.payload.message,
    receivedAt: new Date().toISOString(),
  };
  state.lastError = envelope.payload.message;
  state.statusMessage = `主轴配置保存失败：${envelope.payload.message}`;
  pushHistory("error", state.statusMessage);
}

function reportProtocolError(
  key: string,
  message: string,
  envelope?: ProtocolEnvelope<unknown>,
): void {
  state.lastError = message;
  state.statusMessage = message;
  if (!reportedProtocolWarnings.has(key)) {
    pushHistory("error", message);
    reportedProtocolWarnings.add(key);
  }
  console.warn("[Connection] protocol error.", message, envelope);
}

function reportUnhandledInboundEnvelope(
  envelope: ProtocolEnvelope<unknown>,
): void {
  const key = `type:${envelope.type}`;
  const message = `收到未接入的协议消息 ${envelope.type}。`;
  state.lastError = "";
  state.statusMessage = message;
  if (!reportedProtocolWarnings.has(key)) {
    pushHistory("system", message);
    reportedProtocolWarnings.add(key);
  }
  console.warn("[Connection] unhandled inbound protocol message.", envelope.type, envelope);
}

function updateAssistantText(text: string, turnId: string | null): void {
  state.lastAssistantText = text;

  if (!turnId) {
    pushHistory("assistant", text);
    return;
  }

  const dedupeKey = `${turnId}::${text}`;
  if (assistantHistoryKeySet.has(dedupeKey)) {
    return;
  }

  assistantHistoryKeySet.add(dedupeKey);
  assistantHistoryKeys.push(dedupeKey);
  if (assistantHistoryKeys.length > 120) {
    const expiredKey = assistantHistoryKeys.shift();
    if (expiredKey) {
      assistantHistoryKeySet.delete(expiredKey);
    }
  }

  pushHistory("assistant", text);
}

function queueAssistantTextForPlayback(
  text: string,
  turnId: string | null,
  orchestrationId: string | null,
  messageId: string,
): void {
  queuePendingAssistantTextForPlayback(
    state.pendingAssistantTexts,
    text,
    turnId,
    orchestrationId,
    messageId,
  );
}

function releaseAssistantTextForPlayback(
  messageId: string,
  turnId: string | null,
  orchestrationId: string | null,
): boolean {
  const item = state.pendingAssistantTexts.get(messageId);
  if (!item) {
    return false;
  }
  const text = item.text.trim();
  if (!text) {
    return false;
  }
  if (!matchesPlaybackGroup(
    item.turnId,
    item.orchestrationId,
    turnId,
    orchestrationId,
  )) {
    return false;
  }

  const releasedTurnId = item.turnId ?? turnId;
  const releasedOrchestrationId = item.orchestrationId ?? orchestrationId;
  state.pendingAssistantTexts.delete(messageId);
  updateAssistantText(text, releasedTurnId);
  state.assistantTextDeliveryTurnId = releasedTurnId;
  state.assistantTextDeliveryOrchestrationId = releasedOrchestrationId;
  sessionStore?.markTextDelivered(releasedOrchestrationId, releasedTurnId, messageId);
  state.statusMessage = "文本回复已进入同步播放。";
  return true;
}

function queueAudioForPlayback(
  audioUrl: string,
  turnId: string | null,
  orchestrationId: string | null,
  messageId: string,
): void {
  queuePendingAudioForPlayback(
    state.pendingAudios,
    audioUrl,
    turnId,
    orchestrationId,
    messageId,
  );
  state.statusMessage = "收到语音回复，等待同步播放。";
  pushHistory("system", state.statusMessage);
}

async function playAudioAndAcknowledge(
  audioUrl: string,
  turnId: string | null,
  orchestrationId: string | null = state.currentOrchestrationId,
  messageId: string,
): Promise<void> {
  return playAudioAction(audioPlaybackCtx, audioUrl, turnId, orchestrationId, messageId);
}

function releaseAudioForPlayback(
  messageId: string,
  turnId: string | null,
  orchestrationId: string | null,
): boolean {
  const item = state.pendingAudios.get(messageId);
  if (!item) {
    return false;
  }
  const audioUrl = item.audioUrl.trim();
  if (!audioUrl) {
    return false;
  }
  if (!matchesPlaybackGroup(
    item.turnId,
    item.orchestrationId,
    turnId,
    orchestrationId,
  )) {
    return false;
  }
  const releasedTurnId = item.turnId ?? turnId;
  const releasedOrchestrationId = item.orchestrationId ?? orchestrationId;
  state.pendingAudios.delete(messageId);
  void playAudioAndAcknowledge(
    audioUrl,
    releasedTurnId,
    releasedOrchestrationId,
    messageId,
  );
  return true;
}

function hasPendingAudioForTurn(
  turnId: string | null,
  orchestrationId: string | null,
): boolean {
  for (const item of state.pendingAudios.values()) {
    if (matchesPlaybackGroup(item.turnId, item.orchestrationId, turnId, orchestrationId)) {
      return true;
    }
  }
  return false;
}

function markMissingAudiosForTurn(
  turnId: string | null,
  orchestrationId: string | null,
  reason: string,
): void {
  const sessions = sessionStore?.getSessions() ?? [];
  for (const session of sessions) {
    for (const segmentId of session.segmentOrder) {
      const segment = session.segments.get(segmentId);
      if (
        segment
        && segment.audio.terminal === "idle"
        && !state.pendingAudios.has(segment.messageId)
        && matchesPlaybackGroup(segment.turnId, segment.orchestrationId, turnId, orchestrationId)
      ) {
        markAudioPlaybackTerminal(
          "not_requested",
          segment.turnId,
          segment.orchestrationId,
          reason,
          segment.messageId,
        );
      }
    }
  }
}

function stopAudioPlayback(): void {
  stopAudioAction(audioPlaybackCtx);
}

async function sendText(text: string): Promise<boolean> {
  return sendTextAction(outboundCtx, text);
}

function interruptCurrentTurn(): boolean {
  return sendInterrupt(outboundCtx);
}

function sendSemanticAxisProfileSave(
  payload: SystemSemanticAxisProfileSavePayload,
): boolean {
  return sendProfileSave(outboundCtx, payload);
}

function requestHistoryList(options: { announce?: boolean } = {}): boolean {
  return historyAdapter?.requestHistoryList(options) ?? false;
}

function createHistory(options: { announce?: boolean } = {}): boolean {
  return historyAdapter?.createHistory(options) ?? false;
}

function loadHistory(historyUid: string, options: { announce?: boolean } = {}): boolean {
  return historyAdapter?.loadHistory(historyUid, options) ?? false;
}

function deleteHistory(historyUid: string, options: { announce?: boolean } = {}): boolean {
  return historyAdapter?.deleteHistory(historyUid, options) ?? false;
}

function saveMotionTuningSample(sample: DesktopMotionTuningSample): boolean {
  return motionTuningAdapter?.saveMotionTuningSample(sample) ?? false;
}

function deleteMotionTuningSample(sampleId: string): boolean {
  return motionTuningAdapter?.deleteMotionTuningSample(sampleId) ?? false;
}

function sendMotionPayloadPreview(payload: unknown): boolean {
  return sendMotionPreview(outboundCtx, payload, SCHEMA_MOTION_INTENT_V2, SCHEMA_PARAMETER_PLAN_V2);
}

function sendMotionPlanPreview(plan: unknown): boolean {
  return sendMotionPreview(outboundCtx, plan, SCHEMA_MOTION_INTENT_V2, SCHEMA_PARAMETER_PLAN_V2);
}

async function sendPlaybackFinished(
  turnId: string | null,
  orchestrationId: string | null,
  success: boolean,
  reason?: string,
): Promise<void> {
  sendPlaybackFinishedAction(outboundCtx, turnId, orchestrationId, success, reason);
}

function clearPlaybackGroupContext(
  turnId: string | null,
  orchestrationId: string | null,
): void {
  clearPlaybackGroup(outboundCtx, turnId, orchestrationId);
}

function rewriteModelSyncEnvelope(
  envelope: ProtocolEnvelope<SystemModelSyncPayload>,
): ProtocolEnvelope<SystemModelSyncPayload> {
  return rewriteModelSyncEnvelopeWithActiveHost(envelope, state.activeWsAddress);
}

function rewriteSocketUrl(rawUrl: string): string {
  return rewriteSocketUrlWithActiveHost(rawUrl, state.activeWsAddress);
}

function rewriteHttpUrl(rawUrl: string | null): string {
  return rewriteHttpUrlWithActiveHost(rawUrl, state.activeWsAddress);
}

function pushHistory(role: DesktopHistoryEntry["role"], text: string): void {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return;
  }

  state.historyEntries.push({
    id: createMessageId(),
    role,
    text: normalizedText,
    timestamp: new Date().toISOString(),
  });

  if (state.historyEntries.length > 80) {
    state.historyEntries.splice(0, state.historyEntries.length - 80);
  }
}

export function useAdapterConnection(
  sessionStoreParam?: ReturnType<typeof useTurnPlaybackSessionStore>,
) {
  sessionStore = sessionStoreParam;
  modelSyncAdapter = useModelSync();
  historyAdapter = useAdapterHistory(
    state,
    {
      getSocket: () => socket,
      buildMessageEnvelope,
      pushHistory,
      setLastError: (message: string) => {
        state.lastError = message;
        state.statusMessage = message;
      },
      setStatusMessage: (message: string) => {
        state.statusMessage = message;
      },
    },
  );

  motionTuningAdapter = useAdapterMotionTuning(
    state,
    {
      getSocket: () => socket,
      buildMessageEnvelope,
      pushHistory,
      setLastError: (message: string) => {
        state.lastError = message;
        state.statusMessage = message;
      },
      setStatusMessage: (message: string) => {
        state.statusMessage = message;
      },
    },
  );

  return {
    state: readonly(state),
    initialize,
    setAddress,
    setDesktopScreenshotOnSendEnabled,
    connect,
    disconnect,
    sendText,
    interruptCurrentTurn,
    sendSemanticAxisProfileSave,
    requestHistoryList,
    createHistory,
    loadHistory,
    deleteHistory,
    saveMotionTuningSample,
    deleteMotionTuningSample,
    sendMotionPayloadPreview,
    sendMotionPlanPreview,
    sendPlaybackFinishedForCurrentGroup: sendPlaybackFinished,
    clearPlaybackGroupContext,
    releaseAssistantTextForPlayback,
    releaseAudioForPlayback,
    toggleMicrophoneCapture,
    pushHistory,
  };
}
