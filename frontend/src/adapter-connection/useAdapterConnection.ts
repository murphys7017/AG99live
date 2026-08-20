import { readonly } from "vue";
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
  clearPlaybackGroupContext as clearPlaybackGroup,
  interruptCurrentTurn as sendInterrupt,
  sendMotionLabRawEvent as sendMotionLabRawEventAction,
  sendPlaybackFinished as sendPlaybackFinishedAction,
  sendSemanticAxisProfileSave as sendProfileSave,
  sendText as sendTextAction,
} from "./outbound/outboundActions.js";
import { createAdapterOutboundClient } from "./outbound/outboundClient.js";
import {
  createAdapterAudioRuntime,
  type AdapterAudioRuntime,
} from "./runtime/audioRuntime.js";
import { useAdapterMotionTuning } from "./motion-tuning/useAdapterMotionTuning.js";
import {
  createAdapterMicrophoneRuntime,
} from "./runtime/microphoneRuntime.js";
import type { PlaybackTimelineAudioSink } from "../playback-timeline/audioSink.js";
import type {
  PlaybackTimelineRuntime,
} from "../playback-timeline/playbackTimelineRuntime.js";
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
  createTextSegmentSink,
} from "../playback-timeline/segmentReleaseSinks.js";
import type {
  MotionPayloadNormalizer,
  NormalizedMotionPayload,
} from "../types/motion.js";
import type { MotionLabRawEventInput } from "../motion-lab/outboundQueue.js";
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
  dispose: () => Promise<void>;
  setAddress: (nextAddress: string) => void;
  setDesktopScreenshotOnSendEnabled: (enabled: boolean) => void;
  setMicrophoneDevice: (deviceId: string) => void;
  setMicrophoneDevices: (devices: Parameters<ReturnType<typeof createAdapterMicrophoneRuntime>["setMicrophoneDevices"]>[0]) => void;
  refreshMicrophoneDevices: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sendText: (text: string) => Promise<boolean>;
  interruptCurrentTurn: () => boolean;
  sendSemanticAxisProfileSave: (payload: SystemSemanticAxisProfileSavePayload) => boolean;
  requestHistoryList: (options?: { announce?: boolean }) => boolean;
  createHistory: (options?: { announce?: boolean }) => boolean;
  loadHistory: (historyUid: string, options?: { announce?: boolean }) => boolean;
  deleteHistory: (historyUid: string, options?: { announce?: boolean }) => boolean;
  saveMotionTuningSample: (sample: DesktopMotionTuningSample) => boolean;
  deleteMotionTuningSample: (sampleId: string) => boolean;
  sendMotionLabRawEvent: (
    payload: Parameters<typeof sendMotionLabRawEventAction>[1],
    turnId?: string | null,
  ) => boolean;
  setMotionLabRawEventRecordedHandler: (
    handler: ((eventId: string) => void) | null,
  ) => void;
  setMotionLabRawEventReporter: (
    handler: ((payload: MotionLabRawEventInput, turnId: string | null) => void) | null,
  ) => void;
  sendPlaybackFinishedForCurrentGroup: (
    turnId: string | null,
    success: boolean,
    reason?: string,
  ) => Promise<boolean>;
  clearPlaybackGroupContext: (turnId: string | null) => void;
  toggleMicrophoneCapture: ReturnType<typeof createAdapterMicrophoneRuntime>["toggleMicrophoneCapture"];
  setPttMode: ReturnType<typeof createAdapterMicrophoneRuntime>["setPttMode"];
  setPttKeyBinding: ReturnType<typeof createAdapterMicrophoneRuntime>["setPttKeyBinding"];
  startPttCapture: ReturnType<typeof createAdapterMicrophoneRuntime>["startPttCapture"];
  stopPttCapture: ReturnType<typeof createAdapterMicrophoneRuntime>["stopPttCapture"];
  pushHistory: (role: DesktopHistoryEntry["role"], text: string) => void;
}

export interface AdapterConnectionCompositionInstance extends AdapterConnectionInstance {
  playback: AdapterPlaybackCompositionPort;
}

export interface AdapterPlaybackCompositionPort {
  releaseAssistantTextForPlayback: (
    text: string,
    messageId: string,
    turnId: string | null,
  ) => boolean;
  failAssistantTextForPlayback: (
    messageId: string,
    turnId: string | null,
    reason: string,
  ) => boolean;
  releaseAudioForTimelinePlayback: (
    audioUrl: string,
    messageId: string,
    turnId: string | null,
  ) => boolean;
  initializeAudioRuntime: (
    runtime: PlaybackTimelineRuntime<NormalizedMotionPayload>,
    audioSink: PlaybackTimelineAudioSink,
  ) => void;
}

interface CreateAdapterConnectionOptions {
  sessionStore: SessionStore;
  modelSync: ModelSyncInstance;
  normalizeMotionPayload: MotionPayloadNormalizer;
}

export function createAdapterConnection(
  options: CreateAdapterConnectionOptions,
): AdapterConnectionCompositionInstance {
  const state = createAdapterConnectionState();

  let socket: WebSocket | null = null;
  let initializePromise: Promise<void> | null = null;
  let connectAttemptSerial = 0;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let lifecyclePromise: Promise<void> = Promise.resolve();
  const assistantHistoryKeys: string[] = [];
  const assistantHistoryKeySet = new Set<string>();

  const modelSync = options.modelSync;
  const sessionStore = options.sessionStore;
  let historyAdapter: AdapterHistory | null = null;
  let motionTuningAdapter: AdapterMotionTuning | null = null;
  let motionLabRawEventRecordedHandler: ((eventId: string) => void) | null = null;
  let motionLabRawEventReporter: ((
    payload: MotionLabRawEventInput,
    turnId: string | null,
  ) => void) | null = null;
  let detachPttHookStatusListener: (() => void) | null = null;
  let audioRuntime: AdapterAudioRuntime | null = null;

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

  function requireAudioRuntime(): AdapterAudioRuntime {
    if (!audioRuntime) {
      throw new Error("PlaybackTimelineRuntime has not been attached to the adapter.");
    }
    return audioRuntime;
  }

  function initializeAudioRuntime(
    playbackTimelineRuntime: PlaybackTimelineRuntime<NormalizedMotionPayload>,
    audioSink: PlaybackTimelineAudioSink,
  ): void {
    if (audioRuntime) {
      throw new Error("PlaybackTimelineRuntime may only be attached once.");
    }
    audioRuntime = createAdapterAudioRuntime({
      state,
      audioSink,
      playbackTimelineRuntime,
      pushHistory: pushHistory as (role: string, text: string) => void,
    });
  }

  function stopAudioAndSettleTurn(turnId: string | null, reason: string): void {
    requireAudioRuntime().stopAudioAndSettleTurn(turnId, reason);
  }

  function stopAudioAndSettleAll(reason: string): void {
    requireAudioRuntime().stopAudioAndSettleAll(reason);
  }

  function findActiveAudioSegment() {
    return requireAudioRuntime().findActiveAudioSegment();
  }

  function findOpenAudioSegment() {
    return requireAudioRuntime().findOpenAudioSegment();
  }

  const inboundRuntime = createAdapterInboundRuntime({
    state,
    getSessionStore: () => sessionStore,
    getHistoryAdapter: () => historyAdapter,
    getMotionTuningAdapter: () => motionTuningAdapter,
    getModelSyncAdapter: () => modelSync,
    pushHistory: pushHistory as (role: string, text: string) => void,
    stopAudioAndSettleTurn: (turnId, reason) =>
      stopAudioAndSettleTurn(turnId, reason),
    findActiveAudioSegment: () => findActiveAudioSegment(),
    acknowledgeMotionLabRawEventPersisted: (eventId) =>
      motionLabRawEventRecordedHandler?.(eventId),
    startMicrophoneCapture: (origin) => startMicrophoneCapture(origin),
    normalizeMotionPayload: options.normalizeMotionPayload,
    reportOutputSegmentRejected: (message, envelope) => {
      state.lastError = message;
      state.statusMessage = message;
      pushHistory("error", message);
      console.warn("[Connection] output segment rejected.", message, envelope);
      motionLabRawEventReporter?.({
        event_type: "motion.output_segment_rejected",
        message_id: envelope.message_id,
        source_route: "adapter_inbound",
        phase: "output_segment_rejected",
        payload_kind: "output.segment.v4",
        raw: {
          reason: message,
          type: envelope.type,
          message_id: envelope.message_id,
          turn_id: envelope.turn_id,
          payload: envelope.payload,
        },
      }, envelope.turn_id);
    },
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
    findOpenAudioSegment: () => findOpenAudioSegment(),
    findOpenExecutionSegment: () => requireAudioRuntime().findOpenExecutionSegment(),
    markTurnInterrupted: (turnId: string | null) => {
      if (sessionStore.getSession(turnId)) {
        sessionStore.markInterrupt(turnId);
      }
    },
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
          console.warn("[AdapterConnection] failed to read PTT hook status:", error);
        });
        // 同步持久化的 PTT 模式到主进程 hook
        window.ag99desktop?.setPttMode?.(state.pttModeEnabled, { ...state.pttKeyBinding });
      });
    }

    await initializePromise;
  }

  function connect(): Promise<void> {
    return enqueueLifecycleOperation(async () => {
      if (disposed) {
        throw new Error("Adapter connection runtime has been disposed.");
      }
      try {
        await disconnectInternal(false);
      } catch (error) {
        projectLifecycleFailure("适配器重连清理", error);
        throw error;
      }
      if (disposed) {
        return;
      }

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
    });
  }

  function runConnectionCleanupStep(
    step: string,
    action: () => void,
    errors: unknown[],
  ): void {
    try {
      action();
    } catch (error) {
      console.error(`[AdapterConnection] ${step} failed.`, error);
      errors.push(error);
    }
  }

  async function runConnectionCleanupStepAsync(
    step: string,
    action: () => void | Promise<unknown>,
    errors: unknown[],
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      console.error(`[AdapterConnection] ${step} failed.`, error);
      errors.push(error);
    }
  }

  function enqueueLifecycleOperation(
    operation: () => Promise<void>,
  ): Promise<void> {
    const next = lifecyclePromise.then(operation, operation);
    lifecyclePromise = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function projectLifecycleFailure(action: string, error: unknown): void {
    const details = error instanceof Error ? error.message : String(error);
    state.status = "error";
    state.lastError = `${action}失败：${details}`;
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
  }

  function disconnect(): Promise<void> {
    return enqueueLifecycleOperation(async () => {
      const hadActiveSocket = Boolean(socket);
      try {
        await disconnectInternal(true);
      } catch (error) {
        projectLifecycleFailure("适配器断开清理", error);
        throw error;
      }
      state.status = "disconnected";
      state.statusMessage = "已断开适配器连接。";
      if (!hadActiveSocket) {
        pushHistory("system", state.statusMessage);
      }
    });
  }

  async function disconnectInternal(markManualClose: boolean): Promise<void> {
    connectAttemptSerial += 1;
    const errors: unknown[] = [];
    runConnectionCleanupStep(
      "pending microphone start cancellation",
      () => microphoneRuntime.cancelPendingStart(),
      errors,
    );
    const reason = markManualClose ? "manual_disconnect" : "connection_reset";
    await runConnectionCleanupStepAsync(
      "runtime reset",
      () => resetConnectionRuntimeState(reason),
      errors,
    );
    if (socket) {
      const currentSocket = socket;
      socket = null;
      runConnectionCleanupStep(
        "websocket close",
        () => currentSocket.close(),
        errors,
      );
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  function dispose(): Promise<void> {
    if (disposed) {
      return disposePromise ?? Promise.resolve();
    }
    disposed = true;
    disposePromise = enqueueLifecycleOperation(async () => {
      const errors: unknown[] = [];
      await runConnectionCleanupStepAsync(
        "dispose disconnect",
        () => disconnectInternal(true),
        errors,
      );
      runConnectionCleanupStep(
        "PTT hook listener detach",
        () => detachPttHookStatusListener?.(),
        errors,
      );
      detachPttHookStatusListener = null;
      if (errors.length > 0) {
        projectLifecycleFailure("适配器释放清理", errors[0]);
        throw errors[0];
      }
      state.status = "disconnected";
      state.statusMessage = "已断开适配器连接。";
      state.lastError = "";
    });
    return disposePromise;
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
      onMessage: (nextSocket, rawData) => {
        if (socket !== nextSocket || attemptSerial !== connectAttemptSerial) {
          return;
        }
        inboundRuntime.handleSocketMessage(rawData).catch((error) => {
          if (socket !== nextSocket || attemptSerial !== connectAttemptSerial) {
            return;
          }
          const details = error instanceof Error ? error.message : String(error);
          state.status = "error";
          state.lastError = `入站消息处理失败，连接已关闭：${details}`;
          state.statusMessage = state.lastError;
          pushHistory("error", state.lastError);
          console.error("[AdapterConnection] fatal inbound message handler error:", error);
          const cleanupErrors: unknown[] = [];
          runConnectionCleanupStep(
            "fatal audio and timeline cleanup",
            () => stopAudioAndSettleAll("inbound_runtime_failure"),
            cleanupErrors,
          );
          runConnectionCleanupStep(
            "fatal session failure projection",
            () => failUnresolvedSessions("inbound_runtime_failure"),
            cleanupErrors,
          );
          runConnectionCleanupStep(
            "fatal websocket close",
            () => nextSocket.close(),
            cleanupErrors,
          );
          if (cleanupErrors.length > 0) {
            console.error(
              "[AdapterConnection] fatal inbound cleanup completed with errors.",
              cleanupErrors,
            );
          }
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
        if (socket !== nextSocket) {
          return;
        }

        socket = null;
        void enqueueLifecycleOperation(async () => {
          let cleanupError: unknown = null;
          try {
            await resetConnectionRuntimeState("connection_closed");
          } catch (error) {
            cleanupError = error;
          }

          if (cleanupError !== null) {
            projectLifecycleFailure("连接关闭清理", cleanupError);
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
        }).catch((error) => {
          projectLifecycleFailure("连接关闭清理", error);
        });
      },
    });
    socket = transport.socket;
  }

  async function resetConnectionRuntimeState(reason: string): Promise<void> {
    const errors: unknown[] = [];
    runConnectionCleanupStep(
      "unresolved session failure projection",
      () => failUnresolvedSessions(reason),
      errors,
    );
    await runConnectionCleanupStepAsync(
      "connection runtime state reset",
      () => resetConnectionRuntime({
        state,
        stopMicrophoneCapture,
        stopAudioAndSettleAll,
        historyAdapter,
        modelSyncAdapter: modelSync,
      }, reason),
      errors,
    );
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  function failUnresolvedSessions(reason: string): void {
    const errors: unknown[] = [];
    for (const session of sessionStore.getSessions()) {
      if (session.phase !== "completed" && session.phase !== "failed") {
        runConnectionCleanupStep(
          `session failure (${session.turnId})`,
          () => sessionStore.markSessionFailed(session.turnId, reason),
          errors,
        );
      }
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  function updateAssistantText(text: string, turnId: string | null): void {
    state.lastAssistantText = text;

    if (!turnId) {
      pushHistory("assistant", text);
      return;
    }

    const dedupeKey = `${turnId.length}:${turnId}:${text}`;
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

  const textSegmentSink = createTextSegmentSink({
    state,
    updateAssistantText,
    markTextDelivered: (turnId, messageId) => {
      sessionStore?.markTextDelivered(turnId, messageId);
    },
    markTextFailed: (turnId, messageId, reason) => {
      sessionStore?.markTextFailed(turnId, messageId, reason);
    },
  });

  function releaseAssistantTextForPlayback(
    text: string,
    messageId: string,
    turnId: string | null,
  ): boolean {
    return textSegmentSink.releaseAssistantTextForPlayback(
      text,
      messageId,
      turnId,
    );
  }

  function failAssistantTextForPlayback(
    messageId: string,
    turnId: string | null,
    reason: string,
  ): boolean {
    return textSegmentSink.failAssistantTextForPlayback(
      messageId,
      turnId,
      reason,
    );
  }

  function releaseAudioForTimelinePlayback(
    audioUrl: string,
    messageId: string,
    turnId: string | null,
  ): boolean {
    return requireAudioRuntime().releaseAudioForTimelinePlayback(
      audioUrl,
      messageId,
      turnId,
    );
  }

  function sendText(text: string): Promise<boolean> {
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


  function setMotionLabRawEventRecordedHandler(
    handler: ((eventId: string) => void) | null,
  ): void {
    motionLabRawEventRecordedHandler = handler;
  }

  function setMotionLabRawEventReporter(
    handler: ((payload: MotionLabRawEventInput, turnId: string | null) => void) | null,
  ): void {
    motionLabRawEventReporter = handler;
  }

  async function sendPlaybackFinished(
    turnId: string | null,
    success: boolean,
    reason?: string,
  ): Promise<boolean> {
    return sendPlaybackFinishedAction(outboundCtx, turnId, success, reason);
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
    sendMotionLabRawEvent,
    setMotionLabRawEventRecordedHandler,
    setMotionLabRawEventReporter,
    sendPlaybackFinishedForCurrentGroup: sendPlaybackFinished,
    clearPlaybackGroupContext,
    toggleMicrophoneCapture,
    setPttMode,
    setPttKeyBinding,
    startPttCapture,
    stopPttCapture,
    pushHistory,
    playback: {
      releaseAssistantTextForPlayback,
      failAssistantTextForPlayback,
      releaseAudioForTimelinePlayback,
      initializeAudioRuntime,
    },
  };
}
