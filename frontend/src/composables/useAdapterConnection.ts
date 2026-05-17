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
} from "../types/protocol.js";
import { applyInboundMotionPayload } from "../adapter-connection/inbound/inboundMotion.js";
import {
  clearPlaybackGroupContext as clearPlaybackGroup,
  interruptCurrentTurn as sendInterrupt,
  sendMotionPayloadPreview as sendMotionPreview,
  sendPlaybackFinished as sendPlaybackFinishedAction,
  sendSemanticAxisProfileSave as sendProfileSave,
  sendText as sendTextAction,
} from "../adapter-connection/outbound/outboundActions.js";
import { createAdapterOutboundClient } from "../adapter-connection/outbound/outboundClient.js";
import {
  createAdapterAudioRuntime,
  type AudioPlaybackTerminalState,
} from "../adapter-connection/runtime/audioRuntime.js";
import { useAdapterMotionTuning } from "./useAdapterMotionTuning.js";
import {
  rewriteHttpUrl as rewriteHttpUrlWithActiveHost,
  rewriteModelSyncEnvelope as rewriteModelSyncEnvelopeWithActiveHost,
  rewriteSocketUrl as rewriteSocketUrlWithActiveHost,
} from "../adapter-connection/features/modelSyncRewrite.js";
import {
  createAdapterMicrophoneRuntime,
} from "../adapter-connection/runtime/microphoneRuntime.js";
import type { MicrophoneDeviceInfo } from "../adapter-connection/runtime/microphoneDevices.js";
import {
  startAudioPlayback,
  stopAudioPlaybackRuntime,
} from "../adapter-connection/runtime/audioPlayback.js";
import {
  buildConnectFailureMessage,
  buildConnectionCandidates,
  DEFAULT_ADAPTER_ADDRESS,
  formatAddressHost,
  normalizeWsAddress,
} from "../adapter-connection/core/address.js";
import { openAdapterConnectionTransport } from "../adapter-connection/core/transport.js";
import {
  buildMessageEnvelope as buildProtocolMessageEnvelope,
  createMessageId,
  PROTOCOL_VERSION,
} from "../adapter-connection/core/envelope.js";
import {
  loadDesktopScreenshotOnSendEnabled,
  loadStoredMicrophoneDeviceId,
  loadStoredAdapterAddress,
  normalizeAdapterAddressSetting,
  saveDesktopScreenshotOnSendEnabled,
  saveStoredAdapterAddress,
} from "../adapter-connection/core/preferences.js";
import { parseInboundEnvelope } from "../adapter-connection/inbound/inboundProtocol.js";
import {
  mapInboundEnvelopeToEvent,
  type InboundAdapterEvent,
  type InboundEventMappingContext,
} from "../adapter-connection/inbound/inboundEvents.js";
import {
  matchesPlaybackGroup,
  queueAssistantTextForPlayback as queuePendingAssistantTextForPlayback,
  type PendingAssistantTextItem,
  type PendingAudioItem,
} from "../adapter-connection/runtime/playbackReleaseQueue.js";
import { useModelSync } from "./useModelSync.js";
import { useAdapterHistory } from "./useAdapterHistory.js";
import { normalizeMotionPayload } from "../model-engine/normalize.js";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore.js";
import {
  dispatchInboundEvent as dispatchInboundEventToDeps,
  type InboundDispatchDeps,
} from "../adapter-connection/inbound/inboundDispatcher.js";
import {
  resetConnectionRuntimeState as resetConnectionRuntime,
} from "../adapter-connection/runtime/connectionRuntimeState.js";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

const state = reactive({
  address: loadStoredAdapterAddress(),
  desktopScreenshotOnSendEnabled: loadDesktopScreenshotOnSendEnabled(),
  microphoneDeviceId: loadStoredMicrophoneDeviceId(),
  microphoneDevices: [] as MicrophoneDeviceInfo[],
  status: "disconnected" as ConnectionStatus,
  statusMessage: "尚未连接适配器。",
  serverInfo: null as SystemServerInfoPayload | null,
  activeWsAddress: "",
  lastError: "",
  lastAssistantText: "",
  lastTranscription: "",
  lastImageCount: 0,
  currentTurnId: null as string | null,
  micRequested: false,
  micCapturing: false,
  pttModeEnabled: false,
  isPlayingAudio: false,
  historyEntries: [] as DesktopHistoryEntry[],
  backendHistorySummaries: [] as DesktopBackendHistorySummary[],
  backendHistoryEntries: [] as DesktopBackendHistoryMessage[],
  activeBackendHistoryUid: "",
  backendHistoryLoading: false,
  backendHistoryStatusMessage: "等待历史窗口请求后端历史。",
  inboundMotionPlan: null as unknown | null,
  inboundMotionPlanTurnId: null as string | null,
  inboundMotionPlanReceivedAtMs: 0,
  pendingAssistantTexts: new Map<string, PendingAssistantTextItem>(),
  pendingAudios: new Map<string, PendingAudioItem>(),
  audioPlaybackStartedTurnId: null as string | null,
  audioPlaybackStartedMessageId: null as string | null,
  audioPlaybackStartedAtMs: 0,
  audioPlaybackDurationMs: null as number | null,
  audioPlaybackTerminalState: "idle" as AudioPlaybackTerminalState,
  audioPlaybackTerminalTurnId: null as string | null,
  audioPlaybackTerminalReason: "",
  assistantTextDeliveryTurnId: null as string | null,
  turnFinishedTurnId: null as string | null,
  turnFinishedSuccess: true,
  turnFinishedReason: "",
  latestSemanticAxisProfileSaveResult: null as DesktopSemanticAxisProfileSaveResult | null,
  motionTuningSamples: [] as DesktopMotionTuningSample[],
  motionTuningSamplesStatus: {
    rootError: "",
    loadError: "",
    diagnostics: [],
    effectiveExamples: [],
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
): ProtocolEnvelope<TPayload> {
  return buildProtocolMessageEnvelope(type, payload, turnId);
}

const microphoneRuntime = createAdapterMicrophoneRuntime({
  state,
  getSocket: () => socket,
  buildEnvelope: buildMessageEnvelope as (typeof buildMessageEnvelope),
  pushHistory: pushHistory as (role: "system" | "error", text: string) => void,
  createMessageId,
  setDesktopPttMode: (enabled) => {
    if (typeof window !== "undefined") {
      window.ag99desktop?.setPttMode?.(enabled);
    }
  },
});

const {
  setMicrophoneDevice,
  setMicrophoneDevices,
  refreshMicrophoneDevices,
  toggleMicrophoneCapture,
  startMicrophoneCapture,
  stopMicrophoneCapture,
  setPttMode,
  startPttCapture,
  stopPttCapture,
} = microphoneRuntime;

const audioRuntime = createAdapterAudioRuntime({
  state,
  startAudio: startAudioPlayback,
  stopAudioRuntime: stopAudioPlaybackRuntime,
  pushHistory: pushHistory as (role: string, text: string) => void,
  getSessionStore: () => sessionStore,
});

const {
  queueAudioForPlayback,
  releaseAudioForPlayback,
  hasPendingAudioForTurn,
  markMissingAudiosForTurn,
  markAudioPlaybackTerminal,
  resetAudioPlaybackTerminal,
  stopAudioPlayback,
  findActiveAudioSegment,
} = audioRuntime;

const outboundClient = createAdapterOutboundClient({
  getSocket: () => socket,
  buildEnvelope: buildMessageEnvelope as (typeof buildMessageEnvelope),
});

const outboundCtx = {
  get state() {
    return state;
  },
  outboundClient,
  pushHistory: pushHistory as (role: string, text: string) => void,
  stopAudio: () => stopAudioPlayback(),
  resetAudioPlaybackTerminal,
  createMessageId,
};

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
      void refreshMicrophoneDevices({ requestPermission: false });
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
  microphoneRuntime.clearPendingStart();
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
  const event = mapInboundEnvelopeToEvent(envelope, buildInboundEventContext());
  await dispatchInboundEvent(event);
}

function buildInboundEventContext(): InboundEventMappingContext {
  const activeAudioSegment = findActiveAudioSegment();
  return {
    currentTurnId: state.currentTurnId,
    activeAudioTurnId: activeAudioSegment?.turnId ?? null,
  };
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
          setActiveSession: (tId) => sessionStore?.setActiveSession(tId),
          markTurnStarted: (tId) => sessionStore?.markTurnStarted(tId),
          markSynthFinished: (tId) => sessionStore?.markSynthFinished(tId),
          markTurnFinished: (tId, success, reason) => sessionStore?.markTurnFinished(tId, success, reason),
          markInterrupt: (tId) => sessionStore?.markInterrupt(tId),
          markTextReceived: (tId, text, msgId, mode) => sessionStore?.markTextReceived(tId, text, msgId, mode as "replace" | "append"),
          markTextDelivered: (tId, msgId) => sessionStore?.markTextDelivered(tId, msgId),
          markAudioReceived: (tId, url, msgId) => sessionStore?.markAudioReceived(tId, url, msgId),
          markAudioTerminal: (tId, terminal, msgId, reason) => sessionStore?.markAudioTerminal(tId, terminal as "completed" | "failed" | "absent", msgId, reason),
          markMotionReceived: (tId, payload, msgId) => sessionStore?.markMotionReceived(tId, payload, msgId),
          ensureSegment: (tId, msgId) => sessionStore!.ensureSegment(tId, msgId),
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
    markAudioPlaybackTerminal: (terminalState, turnId, reason, messageId) =>
      markAudioPlaybackTerminal(terminalState as "completed" | "failed" | "absent", turnId, reason, messageId),
    hasPendingAudioForTurn: (turnId) => hasPendingAudioForTurn(turnId),
    markMissingAudiosForTurn: (turnId, reason) => markMissingAudiosForTurn(turnId, reason),
    queuePendingAssistantTextForPlayback: (map, text, turnId, messageId) =>
      queuePendingAssistantTextForPlayback(map, text, turnId, messageId),
    queuePendingAudioForPlayback: (map, url, turnId, messageId) => {
      if (map === state.pendingAudios) {
        queueAudioForPlayback(url, turnId, messageId);
        return;
      }
      map.set(messageId, {
        audioUrl: url,
        turnId,
        messageId,
        receivedAtMs: performance.now(),
      });
    },
    findActiveAudioSegment: () => findActiveAudioSegment(),
    normalizeMotionPayload: (payload) => normalizeMotionPayload(payload),
    applyInboundMotionPayload: (ctx, envelope) =>
      applyInboundMotionPayload(ctx, envelope),
    startMicrophoneCapture: (origin) => startMicrophoneCapture(origin),
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
  messageId: string,
): void {
  queuePendingAssistantTextForPlayback(
    state.pendingAssistantTexts,
    text,
    turnId,
    messageId,
  );
}

function releaseAssistantTextForPlayback(
  messageId: string,
  turnId: string | null,
): boolean {
  const item = state.pendingAssistantTexts.get(messageId);
  if (!item) {
    return false;
  }
  const text = item.text.trim();
  if (!text) {
    return false;
  }
  if (!matchesPlaybackGroup(item.turnId, turnId)) {
    return false;
  }

  const releasedTurnId = item.turnId ?? turnId;
  state.pendingAssistantTexts.delete(messageId);
  updateAssistantText(text, releasedTurnId);
  state.assistantTextDeliveryTurnId = releasedTurnId;
  sessionStore?.markTextDelivered(releasedTurnId, messageId);
  state.statusMessage = "文本回复已进入同步播放。";
  return true;
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
  return sendMotionPreview(outboundCtx, payload, SCHEMA_MOTION_INTENT_V2);
}

async function sendPlaybackFinished(
  turnId: string | null,
  success: boolean,
  reason?: string,
): Promise<void> {
  sendPlaybackFinishedAction(outboundCtx, turnId, success, reason);
}

function clearPlaybackGroupContext(
  turnId: string | null,
): void {
  clearPlaybackGroup(outboundCtx, turnId);
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
    setMicrophoneDevice,
    setMicrophoneDevices,
    refreshMicrophoneDevices,
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
    sendPlaybackFinishedForCurrentGroup: sendPlaybackFinished,
    clearPlaybackGroupContext,
    releaseAssistantTextForPlayback,
    releaseAudioForPlayback,
    toggleMicrophoneCapture,
    setPttMode,
    startPttCapture,
    stopPttCapture,
    pushHistory,
  };
}
