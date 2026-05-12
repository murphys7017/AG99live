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
import { openAdapterConnectionTransport } from "../adapter-connection/transport.js";
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
import {
  dispatchInboundEvent as dispatchInboundEventToDeps,
  type InboundDispatchDeps,
} from "../adapter-connection/inboundDispatcher.js";
import {
  hasPendingAudioForTurn as hasPendingAudioForTurnBridge,
  markAudioPlaybackTerminal as markAudioTerminalBridge,
  markMissingAudiosForTurn as markMissingAudiosForTurnBridge,
  resetAudioPlaybackTerminal as resetAudioTerminalBridge,
  type AudioBridgeDeps,
} from "../adapter-connection/adapterAudioBridge.js";
import {
  resetConnectionRuntimeState as resetConnectionRuntime,
} from "../adapter-connection/connectionRuntimeState.js";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
type AudioPlaybackTerminalState = "idle" | "completed" | "failed" | "absent";

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
          markAudioDuration: (
            orchestrationId: string | null,
            turnId: string | null,
            messageId: string,
            durationMs: number | null,
          ) => sessionStore?.markAudioDuration(
            orchestrationId,
            turnId,
            messageId,
            durationMs,
          ),
        }
      : undefined;
  },
};

const audioBridge = {
  get state() {
    return state;
  },
  get sessionStore() {
    return sessionStore
      ? {
          markAudioTerminal: (
            orchestrationId: string | null,
            turnId: string | null,
            terminal: "completed" | "failed" | "absent",
            messageId: string,
            reason?: string,
          ) => sessionStore?.markAudioTerminal(orchestrationId, turnId, terminal, messageId, reason),
          getSessions: () => sessionStore?.getSessions() ?? [],
        }
      : undefined;
  },
} satisfies AudioBridgeDeps;

function markAudioPlaybackTerminal(
  terminalState: Exclude<AudioPlaybackTerminalState, "idle">,
  turnId: string | null,
  orchestrationId: string | null,
  reason = "",
  messageId: string | null = null,
): void {
  markAudioTerminalBridge(audioBridge, terminalState, turnId, orchestrationId, reason, messageId);
}

function resetAudioPlaybackTerminal(): void {
  resetAudioTerminalBridge(audioBridge);
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

  const transport = openAdapterConnectionTransport(targetAddress, {
    onOpen: (nextSocket) => {
      if (socket !== nextSocket || attemptSerial !== connectAttemptSerial) {
        nextSocket.close();
        return;
      }

      persistAddress(state.address);
      state.activeWsAddress = targetAddress;
      state.status = "connected";
      state.statusMessage = "连接已建立，等待后端同步。";
      state.lastError = "";
      pushHistory("system", `已连接 ${targetAddress}`);
    },
    onMessage: (rawData) => {
      handleSocketMessage(rawData).catch((error) => {
        console.warn("[useAdapterConnection] unhandled error in message handler:", error);
      });
    },
    onError: (nextSocket, opened) => {
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
    },
    onClose: (nextSocket, opened) => {
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
    },
  });
  socket = transport.socket;
}

function resetConnectionRuntimeState(): void {
  resetConnectionRuntime({
    state,
    stopMicrophoneCapture,
    stopAudioPlayback,
    historyAdapter,
    modelSyncAdapter,
    resetAudioPlaybackTerminal,
  });
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

function logProtocolError(
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

async function handleSocketMessage(rawData: string): Promise<void> {
  const parsed = parseInboundEnvelope(rawData);
  if (!parsed.ok) {
    if (parsed.code === "version_mismatch") {
      logProtocolError(
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
  const activeAudioSegment = findActiveAudioSegment();
  return {
    currentTurnId: state.currentTurnId,
    currentOrchestrationId: state.currentOrchestrationId,
    activeAudioTurnId: activeAudioSegment?.turnId ?? null,
    activeAudioOrchestrationId: activeAudioSegment?.orchestrationId ?? null,
  };
}

function findActiveAudioSegment(): {
  turnId: string | null;
  orchestrationId: string | null;
  messageId: string;
} | null {
  const sessions = sessionStore?.getSessions() ?? [];
  for (const session of sessions) {
    for (const segmentId of session.segmentOrder) {
      const segment = session.segments.get(segmentId);
      if (segment?.audio.started && segment.audio.terminal === "idle") {
        return {
          turnId: segment.turnId,
          orchestrationId: segment.orchestrationId,
          messageId: segment.messageId,
        };
      }
    }
  }
  return null;
}

async function dispatchInboundEvent(
  event: InboundAdapterEvent,
): Promise<void> {
  await dispatchInboundEventToDeps(buildDispatchDeps(), event);
}

function buildDispatchDeps(): InboundDispatchDeps {
  return {
    state,
    sessionStore: sessionStore
      ? {
          setActiveSession: (orchId, tId) => sessionStore?.setActiveSession(orchId, tId),
          markTurnStarted: (orchId, tId) => sessionStore?.markTurnStarted(orchId, tId),
          markSynthFinished: (orchId, tId) => sessionStore?.markSynthFinished(orchId, tId),
          markTurnFinished: (orchId, tId, success, reason) => sessionStore?.markTurnFinished(orchId, tId, success, reason),
          markInterrupt: (orchId, tId) => sessionStore?.markInterrupt(orchId, tId),
          markTextReceived: (orchId, tId, text, msgId, mode) => sessionStore?.markTextReceived(orchId, tId, text, msgId, mode as "replace" | "append"),
          markTextDelivered: (orchId, tId, msgId) => sessionStore?.markTextDelivered(orchId, tId, msgId),
          markAudioReceived: (orchId, tId, url, msgId) => sessionStore?.markAudioReceived(orchId, tId, url, msgId),
          markAudioTerminal: (orchId, tId, terminal, msgId, reason) => sessionStore?.markAudioTerminal(orchId, tId, terminal as "completed" | "failed" | "absent", msgId, reason),
          markMotionReceived: (orchId, tId, payload, msgId) => sessionStore?.markMotionReceived(orchId, tId, payload, msgId),
          ensureSegment: (orchId, tId, msgId) => sessionStore!.ensureSegment(orchId, tId, msgId),
          getSessions: () => sessionStore?.getSessions() ?? [],
        }
      : undefined,
    pushHistory: pushHistory as (role: string, text: string) => void,
    modelSyncAdapter: modelSyncAdapter
      ? { applyUnknownMessage: (env) => modelSyncAdapter!.applyUnknownMessage(env) }
      : null,
    historyAdapter: historyAdapter
      ? {
          applyHistoryList: (env) => historyAdapter!.applyHistoryList(env),
          applyHistoryCreated: (env) => historyAdapter!.applyHistoryCreated(env),
          applyHistoryData: (env) => historyAdapter!.applyHistoryData(env),
          applyHistoryDeleted: (env) => historyAdapter!.applyHistoryDeleted(env),
        }
      : null,
    motionTuningAdapter: motionTuningAdapter
      ? { applyMotionTuningSamplesState: (env) => motionTuningAdapter!.applyMotionTuningSamplesState(env) }
      : null,
    rewriteModelSyncEnvelope: (env) => rewriteModelSyncEnvelopeWithActiveHost(env as Parameters<typeof rewriteModelSyncEnvelopeWithActiveHost>[0], state.activeWsAddress),
    rewriteSocketUrl: (url) => rewriteSocketUrlWithActiveHost(url, state.activeWsAddress),
    rewriteHttpUrl: (url) => rewriteHttpUrlWithActiveHost(url, state.activeWsAddress),
    stopAudioPlayback: () => stopAudioPlayback(),
    resetAudioPlaybackTerminal: () => resetAudioPlaybackTerminal(),
    markAudioPlaybackTerminal: (terminalState, turnId, orchestrationId, reason, messageId) =>
      markAudioPlaybackTerminal(terminalState as "completed" | "failed" | "absent", turnId, orchestrationId, reason, messageId),
    hasPendingAudioForTurn: (turnId, orchestrationId) => hasPendingAudioForTurn(turnId, orchestrationId),
    markMissingAudiosForTurn: (turnId, orchestrationId, reason) => markMissingAudiosForTurn(turnId, orchestrationId, reason),
    queuePendingAssistantTextForPlayback: (map, text, turnId, orchestrationId, messageId) =>
      queuePendingAssistantTextForPlayback(map, text, turnId, orchestrationId, messageId),
    queuePendingAudioForPlayback: (map, url, turnId, orchestrationId, messageId) =>
      queuePendingAudioForPlayback(map, url, turnId, orchestrationId, messageId),
    findActiveAudioSegment: () => findActiveAudioSegment(),
    normalizeMotionPayload: (payload) => normalizeMotionPayload(payload),
    applyInboundMotionPayload: (ctx, envelope) =>
      applyInboundMotionPayload(ctx, envelope),
    startMicrophoneCapture: () => startMicrophoneCapture(),
    reportedProtocolWarnings,
    buildInboundEventContext: () => buildInboundEventContext(),
  };
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
  return hasPendingAudioForTurnBridge(audioBridge, turnId, orchestrationId);
}

function markMissingAudiosForTurn(
  turnId: string | null,
  orchestrationId: string | null,
  reason: string,
): void {
  markMissingAudiosForTurnBridge(audioBridge, turnId, orchestrationId, reason);
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
