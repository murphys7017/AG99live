import { onScopeDispose, readonly } from "vue";
import type {
  DeepReadonly,
} from "vue";
import type {
  DesktopHistoryEntry,
  DesktopMotionTuningSample,
} from "../types/desktop";
import type {
  ProtocolEnvelope,
  SystemSemanticAxisProfileSavePayload,
} from "../types/protocol";
import {
  SCHEMA_MOTION_INTENT_V2,
} from "../types/protocol.js";
import {
  clearPlaybackGroupContext as clearPlaybackGroup,
  interruptCurrentTurn as sendInterrupt,
  sendMotionPayloadPreview as sendMotionPreview,
  sendPlaybackFinished as sendPlaybackFinishedAction,
  sendSemanticAxisProfileSave as sendProfileSave,
  sendText as sendTextAction,
} from "./outbound/outboundActions.js";
import { createAdapterOutboundClient } from "./outbound/outboundClient.js";
import {
  createAdapterAudioRuntime,
} from "./runtime/audioRuntime.js";
import { useAdapterMotionTuning } from "./motion-tuning/useAdapterMotionTuning.js";
import {
  createAdapterMicrophoneRuntime,
} from "./runtime/microphoneRuntime.js";
import {
  startAudioPlayback,
  stopAudioPlaybackRuntime,
} from "./runtime/audioPlayback.js";
import {
  buildConnectFailureMessage,
  buildConnectionCandidates,
  DEFAULT_ADAPTER_ADDRESS,
  formatAddressHost,
  normalizeWsAddress,
} from "./core/address.js";
import { openAdapterConnectionTransport } from "./core/transport.js";
import {
  buildMessageEnvelope as buildProtocolMessageEnvelope,
  createMessageId,
} from "./core/envelope.js";
import {
  loadStoredAdapterAddress,
  normalizeAdapterAddressSetting,
  saveDesktopScreenshotOnSendEnabled,
  saveStoredAdapterAddress,
} from "./core/preferences.js";
import {
  matchesPlaybackGroup,
  queueAssistantTextForPlayback as queuePendingAssistantTextForPlayback,
} from "./runtime/playbackReleaseQueue.js";
import {
  type ModelSyncInstance,
} from "./model-sync/useModelSync.js";
import { useAdapterHistory } from "./history/useAdapterHistory.js";
import type { useTurnPlaybackSessionStore } from "../turn-playback/useTurnPlaybackSessionStore.js";
import {
  resetConnectionRuntimeState as resetConnectionRuntime,
} from "./runtime/connectionRuntimeState.js";
import { createAdapterConnectionState } from "./state/adapterConnectionState.js";
import { createAdapterInboundRuntime } from "./inbound/adapterInboundRuntime.js";

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;
type AdapterHistory = ReturnType<typeof useAdapterHistory>;
type AdapterMotionTuning = ReturnType<typeof useAdapterMotionTuning>;

export interface AdapterConnectionInstance {
  readonly state: DeepReadonly<ReturnType<typeof createAdapterConnectionState>>;
  readonly modelSync: ModelSyncInstance;
  initialize: () => Promise<void>;
  dispose: () => void;
  setAddress: (nextAddress: string) => void;
  setDesktopScreenshotOnSendEnabled: (enabled: boolean) => void;
  setMicrophoneDevice: (deviceId: string) => void;
  setMicrophoneDevices: (devices: Parameters<ReturnType<typeof createAdapterMicrophoneRuntime>["setMicrophoneDevices"]>[0]) => void;
  refreshMicrophoneDevices: () => Promise<void>;
  connect: () => void;
  disconnect: () => void;
  sendText: (text: string) => Promise<boolean>;
  interruptCurrentTurn: () => boolean;
  sendSemanticAxisProfileSave: (payload: SystemSemanticAxisProfileSavePayload) => boolean;
  requestHistoryList: (options?: { announce?: boolean }) => boolean;
  createHistory: (options?: { announce?: boolean }) => boolean;
  loadHistory: (historyUid: string, options?: { announce?: boolean }) => boolean;
  deleteHistory: (historyUid: string, options?: { announce?: boolean }) => boolean;
  saveMotionTuningSample: (sample: DesktopMotionTuningSample) => boolean;
  deleteMotionTuningSample: (sampleId: string) => boolean;
  sendMotionPayloadPreview: (payload: unknown) => boolean;
  sendPlaybackFinishedForCurrentGroup: (
    turnId: string | null,
    success: boolean,
    reason?: string,
  ) => Promise<void>;
  clearPlaybackGroupContext: (turnId: string | null) => void;
  releaseAssistantTextForPlayback: (messageId: string, turnId: string | null) => boolean;
  releaseAudioForPlayback: ReturnType<typeof createAdapterAudioRuntime>["releaseAudioForPlayback"];
  toggleMicrophoneCapture: ReturnType<typeof createAdapterMicrophoneRuntime>["toggleMicrophoneCapture"];
  setPttMode: ReturnType<typeof createAdapterMicrophoneRuntime>["setPttMode"];
  setPttKeyBinding: ReturnType<typeof createAdapterMicrophoneRuntime>["setPttKeyBinding"];
  startPttCapture: ReturnType<typeof createAdapterMicrophoneRuntime>["startPttCapture"];
  stopPttCapture: ReturnType<typeof createAdapterMicrophoneRuntime>["stopPttCapture"];
  pushHistory: (role: DesktopHistoryEntry["role"], text: string) => void;
}

interface CreateAdapterConnectionOptions {
  sessionStore?: SessionStore;
  modelSync: ModelSyncInstance;
}

export function createAdapterConnection(
  options: CreateAdapterConnectionOptions,
): AdapterConnectionInstance {
  const state = createAdapterConnectionState();

  let socket: WebSocket | null = null;
  let manualClose = false;
  let initializePromise: Promise<void> | null = null;
  let connectAttemptSerial = 0;
  let disposed = false;
  const assistantHistoryKeys: string[] = [];
  const assistantHistoryKeySet = new Set<string>();

  const modelSync = options.modelSync;
  const sessionStore = options.sessionStore;
  let historyAdapter: AdapterHistory | null = null;
  let motionTuningAdapter: AdapterMotionTuning | null = null;

  function buildMessageEnvelope<TPayload>(
    type: string,
    payload: TPayload,
    turnId: string | null = null,
  ): ProtocolEnvelope<TPayload> {
    return buildProtocolMessageEnvelope(type, payload, turnId);
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

  const microphoneRuntime = createAdapterMicrophoneRuntime({
    state,
    getSocket: () => socket,
    buildEnvelope: buildMessageEnvelope as (typeof buildMessageEnvelope),
    pushHistory: pushHistory as (role: "system" | "error", text: string) => void,
    createMessageId,
    setDesktopPttMode: (enabled, binding) => {
      if (typeof window !== "undefined") {
        window.ag99desktop?.setPttMode?.(enabled, binding);
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
    setPttKeyBinding,
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

  const inboundRuntime = createAdapterInboundRuntime({
    state,
    getSessionStore: () => sessionStore,
    getHistoryAdapter: () => historyAdapter,
    getMotionTuningAdapter: () => motionTuningAdapter,
    getModelSyncAdapter: () => modelSync,
    pushHistory: pushHistory as (role: string, text: string) => void,
    stopAudioPlayback: () => stopAudioPlayback(),
    resetAudioPlaybackTerminal: () => resetAudioPlaybackTerminal(),
    markAudioPlaybackTerminal: (terminalState, turnId, reason, messageId) =>
      markAudioPlaybackTerminal(terminalState, turnId, reason, messageId),
    hasPendingAudioForTurn: (turnId) => hasPendingAudioForTurn(turnId),
    markMissingAudiosForTurn: (turnId, reason) => markMissingAudiosForTurn(turnId, reason),
    queueAudioForPlayback: (url, turnId, messageId) =>
      queueAudioForPlayback(url, turnId, messageId),
    findActiveAudioSegment: () => findActiveAudioSegment(),
    startMicrophoneCapture: (origin) => startMicrophoneCapture(origin),
  });

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
    if (disposed) {
      throw new Error("Adapter connection runtime has been disposed.");
    }
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
    if (disposed) {
      throw new Error("Adapter connection runtime has been disposed.");
    }
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

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    disconnectInternal(true);
    resetConnectionRuntimeState();
    state.status = "disconnected";
    state.statusMessage = "已断开适配器连接。";
    state.lastError = "";
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
        inboundRuntime.handleSocketMessage(rawData).catch((error) => {
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
      modelSyncAdapter: modelSync,
      resetAudioPlaybackTerminal,
    });
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
    modelSync,
    initialize,
    dispose,
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
    setPttKeyBinding,
    startPttCapture,
    stopPttCapture,
    pushHistory,
  };
}

export function useAdapterConnection(
  sessionStore: SessionStore | undefined,
  modelSync: ModelSyncInstance,
): AdapterConnectionInstance {
  const connection = createAdapterConnection({
    sessionStore,
    modelSync,
  });

  onScopeDispose(() => {
    connection.dispose();
  });

  return connection;
}
