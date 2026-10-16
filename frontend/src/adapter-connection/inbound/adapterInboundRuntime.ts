import type { ProtocolEnvelope, SystemModelSyncPayload, SystemDesktopSettingsQueryPayload } from "../../types/protocol.js";
import type { MotionPayloadNormalizer } from "../../types/motion.js";
import type { AdapterConnectionState } from "../state/adapterConnectionState.js";
import { parseInboundEnvelope } from "./inboundProtocol.js";
import { applyDeferredMotion } from "./deferredMotionProtocol.js";
import { dispatchInboundRuntimeEvent } from "./inboundRuntimeDispatcher.js";
import { parseIncrementalOutputEvent } from "./incrementalOutputProtocol.js";
import { createIncrementalOutputRuntime } from "./incrementalOutputRuntime.js";
import type { PcmTimelineStream } from "../../playback-timeline/pcmTimelinePlayback.js";
import {
  mapInboundEnvelopeToEvent,
  type InboundAdapterEvent,
  type InboundEventMappingContext,
} from "./inboundEvents.js";
import {
  dispatchInboundEvent as dispatchInboundEventToDeps,
  type InboundDispatchDeps,
} from "./inboundDispatcher.js";
import {
  rewriteHttpUrl as rewriteHttpUrlWithActiveHost,
  rewriteModelSyncEnvelope as rewriteModelSyncEnvelopeWithActiveHost,
  rewriteSocketUrl as rewriteSocketUrlWithActiveHost,
} from "../features/modelSyncRewrite.js";
import type { useAdapterHistory } from "../history/useAdapterHistory.js";
import type { useAdapterMotionTuning } from "../motion-tuning/useAdapterMotionTuning.js";
import type { ModelSyncInstance } from "../model-sync/useModelSync.js";
import type { useTurnPlaybackSessionStore } from "../../turn-playback/useTurnPlaybackSessionStore.js";

export interface AdapterInboundRuntimeDeps {
  state: AdapterConnectionState;
  getSessionStore: () => ReturnType<typeof useTurnPlaybackSessionStore>;
  openPcmForTimelinePlayback(turnId: string, messageId: string): Promise<PcmTimelineStream>;
  displayIncrementalText(text: string, turnId: string): void;
  recordIncrementalText(text: string, turnId: string): void;
  sendAudioCredit: Parameters<typeof createIncrementalOutputRuntime>[0]["sendAudioCredit"];
  onAsyncMessageError(error: unknown): void;
  getHistoryAdapter: () => ReturnType<typeof useAdapterHistory> | null;
  getMotionTuningAdapter: () => ReturnType<typeof useAdapterMotionTuning> | null;
  getModelSyncAdapter: () => ModelSyncInstance | null;
  pushHistory: (role: string, text: string) => void;
  stopAudioAndSettleTurn: (turnId: string | null, reason: string) => void;
  findActiveAudioSegment: () => { turnId: string | null; messageId: string } | null;
  acknowledgeMotionLabRawEventPersisted: (eventId: string) => void;
  handleDesktopSettingsQuery: (envelope: ProtocolEnvelope<SystemDesktopSettingsQueryPayload>) => void;
  startMicrophoneCapture: (origin?: "manual" | "ptt" | "auto") => Promise<boolean>;
  normalizeMotionPayload: MotionPayloadNormalizer;
  reportOutputSegmentRejected: (
    message: string,
    envelope: ProtocolEnvelope<unknown>,
  ) => void;
  notifyTurnLifecycle: (event: { phase: "started" | "terminal"; turnId: string }) => void;
}

export function createAdapterInboundRuntime(deps: AdapterInboundRuntimeDeps) {
  const reportedProtocolWarnings = new Set<string>();
  const incremental = createIncrementalOutputRuntime({
    getStore: deps.getSessionStore,
    currentTurnId: () => deps.state.currentTurnId,
    openPcm: (turnId, messageId) => deps.openPcmForTimelinePlayback(turnId, messageId),
    displayText: (text, turnId) => deps.displayIncrementalText(text, turnId),
    recordText: (text, turnId) => deps.recordIncrementalText(text, turnId),
    sendAudioCredit: deps.sendAudioCredit,
    onAsyncError: deps.onAsyncMessageError,
  });

  function logProtocolError(
    key: string,
    message: string,
    envelope?: ProtocolEnvelope<unknown>,
  ): void {
    deps.state.lastError = message;
    deps.state.statusMessage = message;
    if (!reportedProtocolWarnings.has(key)) {
      deps.pushHistory("error", message);
      reportedProtocolWarnings.add(key);
    }
    console.warn("[Connection] protocol error.", message, envelope);
  }

  function reportRuntimeProtocolViolation(message: string): void {
    deps.state.lastError = message;
    deps.state.statusMessage = message;
    deps.pushHistory("error", message);
    console.warn("[Connection] runtime protocol violation.", message);
  }

  function tryHandlePriorityInterrupt(rawData: string | ArrayBuffer | Blob): boolean {
    if (typeof rawData !== "string" || deps.state.serverInfo === null) return false;
    // Full envelope and event validation still apply. Unknown/future Turns stay
    // in wire order so their turn_started cannot be overtaken by an interrupt.
    const parsed = parseInboundEnvelope(rawData);
    if (!parsed.ok || parsed.envelope.type !== "control.interrupt") return false;
    const event = mapInboundEnvelopeToEvent(parsed.envelope, buildInboundEventContext());
    if (event.kind !== "interrupt" || event.turnId !== deps.state.currentTurnId) return false;
    dispatchInboundRuntimeEvent(buildDispatchDeps(), event);
    return true;
  }

  async function handleSocketMessage(rawData: string | ArrayBuffer | Blob, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (typeof rawData !== "string") {
      if (deps.state.serverInfo === null) throw new Error("incremental_output_before_handshake");
      const buffer = rawData instanceof Blob ? await rawData.arrayBuffer() : rawData;
      signal?.throwIfAborted();
      incremental.handleAudio(buffer, signal);
      return;
    }
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

      deps.state.lastError = parsed.message;
      deps.state.statusMessage = parsed.message;
      deps.pushHistory("error", parsed.message);
      return;
    }

    const envelope = parsed.envelope;
    if (envelope.type === "output.segment_motion") {
      if (deps.state.serverInfo === null) throw new Error("deferred_motion_before_handshake");
      applyDeferredMotion(envelope, deps.getSessionStore(), deps.normalizeMotionPayload);
      return;
    }
    const streamEvent = parseIncrementalOutputEvent(envelope);
    if (streamEvent) {
      if (deps.state.serverInfo === null) throw new Error("incremental_output_before_handshake");
      incremental.handleEvent(streamEvent);
      return;
    }
    const event = mapInboundEnvelopeToEvent(envelope, buildInboundEventContext());
    await dispatchInboundEvent(event);
  }

  function buildInboundEventContext(): InboundEventMappingContext {
    return {
      currentTurnId: deps.state.currentTurnId,
    };
  }

  async function dispatchInboundEvent(
    event: InboundAdapterEvent,
  ): Promise<void> {
    if (
      deps.state.serverInfo === null
      && event.kind !== "server_info"
      && event.kind !== "protocol_error"
    ) {
      logProtocolError(
        "handshake:not_complete",
        `协议握手尚未完成，拒绝处理 ${event.envelope.type}。请重载 AstrBot 插件后重新连接。`,
        event.envelope,
      );
      return;
    }
    await dispatchInboundEventToDeps(buildDispatchDeps(), event);
  }

  function buildDispatchDeps(): InboundDispatchDeps {
    const sessionStore = deps.getSessionStore();
    const historyAdapter = deps.getHistoryAdapter();
    const modelSyncAdapter = deps.getModelSyncAdapter();
    const motionTuningAdapter = deps.getMotionTuningAdapter();

    return {
      state: deps.state,
      sessionStore,
      pushHistory: deps.pushHistory,
      modelSyncAdapter: modelSyncAdapter
        ? {
            applyModelSyncMessage: (env) => modelSyncAdapter.applyModelSyncMessage(env),
          }
        : null,
      historyAdapter: historyAdapter
        ? {
            applyHistoryList: (env) => historyAdapter.applyHistoryList(env),
            applyHistoryCreated: (env) => historyAdapter.applyHistoryCreated(env),
            applyHistoryData: (env) => historyAdapter.applyHistoryData(env),
            applyHistoryDeleted: (env) => historyAdapter.applyHistoryDeleted(env),
          }
        : null,
      motionTuningAdapter: motionTuningAdapter
        ? { applyMotionTuningSamplesState: (env) => motionTuningAdapter.applyMotionTuningSamplesState(env) }
        : null,
      acknowledgeMotionLabRawEventPersisted: (eventId) =>
        deps.acknowledgeMotionLabRawEventPersisted(eventId),
      handleDesktopSettingsQuery: (envelope) =>
        deps.handleDesktopSettingsQuery(envelope),
      rewriteModelSyncEnvelope: (env) => rewriteModelSyncEnvelope(env),
      rewriteSocketUrl: (url) => rewriteSocketUrl(url),
      rewriteHttpUrl: (url) => rewriteHttpUrl(url),
      stopAudioAndSettleTurn: (turnId, reason) =>
        deps.stopAudioAndSettleTurn(turnId, reason),
      reportRuntimeProtocolViolation,
      reportOutputSegmentRejected: (message, envelope) =>
        deps.reportOutputSegmentRejected(message, envelope),
      findActiveAudioSegment: () => deps.findActiveAudioSegment(),
      normalizeMotionPayload: deps.normalizeMotionPayload,
      startMicrophoneCapture: (origin) => deps.startMicrophoneCapture(origin),
      notifyTurnLifecycle: (event) => {
        if (event.phase === "terminal") incremental.cancelTurn(event.turnId);
        deps.notifyTurnLifecycle(event);
      },
      reportedProtocolWarnings,
      buildInboundEventContext: () => buildInboundEventContext(),
    };
  }

  function rewriteModelSyncEnvelope(
    envelope: ProtocolEnvelope<SystemModelSyncPayload>,
  ): ProtocolEnvelope<SystemModelSyncPayload> {
    return rewriteModelSyncEnvelopeWithActiveHost(
      envelope,
      deps.state.activeWsAddress,
    );
  }

  function rewriteSocketUrl(rawUrl: string): string {
    return rewriteSocketUrlWithActiveHost(rawUrl, deps.state.activeWsAddress);
  }

  function rewriteHttpUrl(rawUrl: string | null): string {
    return rewriteHttpUrlWithActiveHost(rawUrl, deps.state.activeWsAddress);
  }

  return {
    resetIncremental: incremental.reset,
    tryHandlePriorityInterrupt,
    handleSocketMessage,
    buildInboundEventContext,
    dispatchInboundEvent,
    buildDispatchDeps,
  };
}
