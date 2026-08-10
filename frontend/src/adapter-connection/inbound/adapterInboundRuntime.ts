import type { ProtocolEnvelope, SystemModelSyncPayload } from "../../types/protocol.js";
import type { MotionPayloadNormalizer } from "../../playback-integrations/motionPayload.js";
import type { AdapterConnectionState } from "../state/adapterConnectionState.js";
import { parseInboundEnvelope } from "./inboundProtocol.js";
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
  getSessionStore: () => ReturnType<typeof useTurnPlaybackSessionStore> | undefined;
  getHistoryAdapter: () => ReturnType<typeof useAdapterHistory> | null;
  getMotionTuningAdapter: () => ReturnType<typeof useAdapterMotionTuning> | null;
  getModelSyncAdapter: () => ModelSyncInstance | null;
  pushHistory: (role: string, text: string) => void;
  stopAudioAndSettleTurn: (turnId: string | null, reason: string) => void;
  findActiveAudioSegment: () => { turnId: string | null; messageId: string } | null;
  acknowledgeMotionLabRawEventPersisted: (eventId: string) => void;
  startMicrophoneCapture: (origin?: "manual" | "ptt" | "auto") => Promise<boolean>;
  normalizeMotionPayload: MotionPayloadNormalizer;
}

export function createAdapterInboundRuntime(deps: AdapterInboundRuntimeDeps) {
  const reportedProtocolWarnings = new Set<string>();

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

  async function handleSocketMessage(rawData: string | ArrayBuffer | Blob): Promise<void> {
    if (typeof rawData !== "string") {
      console.warn("[Connection] ignored non-JSON inbound websocket payload.");
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
      sessionStore: sessionStore
        ? {
            setActiveSession: (tId) => sessionStore.setActiveSession(tId),
            markTurnStarted: (tId) => sessionStore.markTurnStarted(tId),
            markSynthFinished: (tId) => sessionStore.markSynthFinished(tId),
            markTurnFinished: (tId, success, reason) => sessionStore.markTurnFinished(tId, success, reason),
            markInterrupt: (tId) => sessionStore.markInterrupt(tId),
            assertOutputSegmentsResolved: (tId) =>
              sessionStore.assertOutputSegmentsResolved(tId),
            commitOutputSegment: (tId, msgId, material) =>
              sessionStore.commitOutputSegment(tId, msgId, material),
          }
        : undefined,
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
      rewriteModelSyncEnvelope: (env) => rewriteModelSyncEnvelope(env),
      rewriteSocketUrl: (url) => rewriteSocketUrl(url),
      rewriteHttpUrl: (url) => rewriteHttpUrl(url),
      stopAudioAndSettleTurn: (turnId, reason) =>
        deps.stopAudioAndSettleTurn(turnId, reason),
      reportRuntimeProtocolViolation,
      findActiveAudioSegment: () => deps.findActiveAudioSegment(),
      normalizeMotionPayload: deps.normalizeMotionPayload,
      startMicrophoneCapture: (origin) => deps.startMicrophoneCapture(origin),
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
    handleSocketMessage,
    buildInboundEventContext,
    dispatchInboundEvent,
    buildDispatchDeps,
  };
}
