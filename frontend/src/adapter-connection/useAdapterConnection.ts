import { onScopeDispose, readonly } from "vue";
import type {
  DeepReadonly,
} from "vue";
import type {
  DesktopHistoryEntry,
  DesktopMotionTuningSample,
  DesktopPttHookStatus,
} from "../types/desktop";
import type {
  ProtocolEnvelope,
  SystemSemanticAxisProfileSavePayload,
} from "../types/protocol";
import {
  SCHEMA_MOTION_INTENT_V3,
} from "../types/protocol.js";
import {
  clearPlaybackGroupContext as clearPlaybackGroup,
  interruptCurrentTurn as sendInterrupt,
  sendMotionLabRawEvent as sendMotionLabRawEventAction,
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
  createBrowserAudioTimelineSink,
} from "../playback-timeline/audioSink.js";
import type {
  PlaybackTimelineSnapshot,
} from "../playback-timeline/contracts.js";
import {
  buildConnectFailureMessage,
  buildConnectionCandidates,
  DEFAULT_ADAPTER_ADDRESS,
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
} from "../playback-timeline/playbackReleaseQueue.js";
import {
  createQueuedTextSegmentSink,
} from "../playback-timeline/segmentReleaseSinks.js";
import type {
  PlaybackTimelineSegmentMotionSink,
} from "../playback-timeline/segmentJob.js";
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
type AdapterAudioRuntimeInstance = ReturnType<typeof createAdapterAudioRuntime>;

export interface AdapterPlaybackTimelinePort {
  setAudioTimelineStartedHandler: (
    handler: ((
      turnId: string | null,
      messageId: string,
      playbackTimeline: PlaybackTimelineSnapshot | null,
    ) => void) | null,
  ) => void;
  configureSegmentExecution: (options: {
    motionSink: Pick<PlaybackTimelineSegmentMotionSink, "start">;
  }) => void;
  startSegmentJob: AdapterAudioRuntimeInstance["startSegmentJob"];
  getPlaybackTimelineSnapshotForSegment: AdapterAudioRuntimeInstance["getPlaybackTimelineSnapshotForSegment"];
  markMotionTimelineStarted: AdapterAudioRuntimeInstance["markMotionTimelineStarted"];
  markMotionTimelineTerminal: AdapterAudioRuntimeInstance["markMotionTimelineTerminal"];
}

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
  sendMotionLabRawEvent: (
    payload: Parameters<typeof sendMotionLabRawEventAction>[1],
    turnId?: string | null,
  ) => boolean;
  setMotionPreviewHandler: (handler: ((payload: unknown) => boolean) | null) => void;
  sendPlaybackFinishedForCurrentGroup: (
    turnId: string | null,
    success: boolean,
    reason?: string,
  ) => Promise<void>;
  clearPlaybackGroupContext: (turnId: string | null) => void;
  playbackTimeline: AdapterPlaybackTimelinePort;
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
  let motionPreviewHandler: ((payload: unknown) => boolean) | null = null;
  let audioTimelineStartedHandler: ((
    turnId: string | null,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot | null,
  ) => void) | null = null;
  let detachPttHookStatusListener: (() => void) | null = null;

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
        window.ag99desktop?.setPttMode?.(enabled, binding ? { ...binding } : binding);
      }
    },
  });

  function applyPttHookStatus(payload: DesktopPttHookStatus): void {
    state.pttHookStatus = {
      available: Boolean(payload.available),
      enabled: Boolean(payload.enabled),
      keycode: typeof payload.keycode === "number" && Number.isFinite(payload.keycode)
        ? Math.round(payload.keycode)
        : null,
      reason: typeof payload.reason === "string" ? payload.reason : "",
      updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : new Date().toISOString(),
    };
  }

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
    audioSink: createBrowserAudioTimelineSink(),
    pushHistory: pushHistory as (role: string, text: string) => void,
    getSessionStore: () => sessionStore,
    onAudioTimelineStarted: (turnId, messageId, playbackTimeline) =>
      audioTimelineStartedHandler?.(turnId, messageId, playbackTimeline),
  });

  const {
    queueAudioForPlayback,
    configureSegmentExecution: configureAudioSegmentExecution,
    startSegmentJob,
    getPlaybackTimelineSnapshotForSegment,
    markMotionTimelineStarted,
    markMotionTimelineTerminal,
    hasPendingAudioForTurn,
    markAudioPlaybackTerminal,
    resetAudioPlaybackTerminal,
    stopAudioAndSettleTurn,
    stopAudioAndSettleAll,
    findActiveAudioSegment,
    findOpenAudioSegment,
  } = audioRuntime;

  const inboundRuntime = createAdapterInboundRuntime({
    state,
    getSessionStore: () => sessionStore,
    getHistoryAdapter: () => historyAdapter,
    getMotionTuningAdapter: () => motionTuningAdapter,
    getModelSyncAdapter: () => modelSync,
    pushHistory: pushHistory as (role: string, text: string) => void,
    stopAudioAndSettleTurn: (turnId, reason) =>
      stopAudioAndSettleTurn(turnId, reason),
    resetAudioPlaybackTerminal: () => resetAudioPlaybackTerminal(),
    markAudioPlaybackTerminal: (terminalState, turnId, reason, messageId) =>
      markAudioPlaybackTerminal(terminalState, turnId, reason, messageId),
    hasPendingAudioForTurn: (turnId) => hasPendingAudioForTurn(turnId),
    queueAudioForPlayback: (url, turnId, messageId) =>
      queueAudioForPlayback(url, turnId, messageId),
    findActiveAudioSegment: () => findActiveAudioSegment(),
    playMotionPreviewPayload: (payload) => motionPreviewHandler?.(payload) ?? false,
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
    stopAudioAndSettleTurn: (turnId: string | null, reason: string) =>
      stopAudioAndSettleTurn(turnId, reason),
    resetAudioPlaybackTerminal,
    findOpenAudioSegment: () => findOpenAudioSegment(),
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
        detachPttHookStatusListener?.();
        detachPttHookStatusListener = window.ag99desktop?.onPttHookStatus?.(applyPttHookStatus) ?? null;
        void window.ag99desktop?.getPttHookStatus?.().then(applyPttHookStatus).catch((error: unknown) => {
          console.warn("[useAdapterConnection] failed to read PTT hook status:", error);
        });
        // 同步持久化的 PTT 模式到主进程 hook
        window.ag99desktop?.setPttMode?.(state.pttModeEnabled, { ...state.pttKeyBinding });
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
    stopAudioAndSettleAll(markManualClose ? "manual_disconnect" : "connection_reset");
    state.pendingMotions.clear();
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
    detachPttHookStatusListener?.();
    detachPttHookStatusListener = null;
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
    state.status = "connecting";
    state.statusMessage = "正在连接适配器...";

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
      stopAudioAndSettleAll,
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

  const queuedTextSegmentSink = createQueuedTextSegmentSink({
    state,
    updateAssistantText,
    markTextDelivered: (turnId, messageId) => {
      sessionStore?.markTextDelivered(turnId, messageId);
    },
  });

  function releaseAssistantTextForPlayback(
    messageId: string,
    turnId: string | null,
  ): boolean {
    return queuedTextSegmentSink.releaseAssistantTextForPlayback(
      messageId,
      turnId,
    );
  }

  function configureSegmentExecution(options: {
    motionSink: Pick<PlaybackTimelineSegmentMotionSink, "start">;
  }): void {
    if (!sessionStore) {
      throw new Error("Playback segment execution requires a turn playback session store.");
    }
    configureAudioSegmentExecution({
      session: {
        markTextReleased: sessionStore.markTextReleased,
        markAudioReleased: sessionStore.markAudioReleased,
        markMotionReleased: sessionStore.markMotionReleased,
        markMotionFailed: sessionStore.markMotionFailed,
        markPhase: sessionStore.markPhase,
      },
      textSink: {
        releaseAssistantTextForPlayback,
      },
      motionSink: {
        start: options.motionSink.start,
      },
    });
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

  function sendMotionLabRawEvent(
    payload: Parameters<typeof sendMotionLabRawEventAction>[1],
    turnId?: string | null,
  ): boolean {
    return sendMotionLabRawEventAction(outboundCtx, payload, turnId);
  }

  function sendMotionPayloadPreview(payload: unknown): boolean {
    return sendMotionPreview(outboundCtx, payload, [
      SCHEMA_MOTION_INTENT_V3,
    ]);
  }

  function setMotionPreviewHandler(
    handler: ((payload: unknown) => boolean) | null,
  ): void {
    motionPreviewHandler = handler;
  }

  function setAudioTimelineStartedHandler(
    handler: typeof audioTimelineStartedHandler,
  ): void {
    audioTimelineStartedHandler = handler;
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

  const playbackTimeline: AdapterPlaybackTimelinePort = {
    setAudioTimelineStartedHandler,
    configureSegmentExecution,
    startSegmentJob,
    getPlaybackTimelineSnapshotForSegment,
    markMotionTimelineStarted,
    markMotionTimelineTerminal,
  };

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
    sendMotionLabRawEvent,
    setMotionPreviewHandler,
    sendPlaybackFinishedForCurrentGroup: sendPlaybackFinished,
    clearPlaybackGroupContext,
    playbackTimeline,
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
