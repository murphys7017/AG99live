import type { ProtocolEnvelope, SystemModelSyncPayload } from "../../types/protocol.js";
import type { NormalizedMotionPayload } from "../../model-engine/contracts.js";
import { normalizeMotionPayload } from "../../model-engine/normalize.js";
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
import { applyInboundMotionPayload } from "./inboundMotion.js";
import {
  rewriteHttpUrl as rewriteHttpUrlWithActiveHost,
  rewriteModelSyncEnvelope as rewriteModelSyncEnvelopeWithActiveHost,
  rewriteSocketUrl as rewriteSocketUrlWithActiveHost,
} from "../features/modelSyncRewrite.js";
import {
  buildPendingPlaybackKey,
  matchesPlaybackGroup,
  queueAssistantTextForPlayback as queuePendingAssistantTextForPlayback,
} from "../../playback-timeline/playbackReleaseQueue.js";
import type { useAdapterHistory } from "../history/useAdapterHistory.js";
import type { useAdapterMotionTuning } from "../motion-tuning/useAdapterMotionTuning.js";
import type { useModelSync } from "../model-sync/useModelSync.js";
import type { useTurnPlaybackSessionStore } from "../../turn-playback/useTurnPlaybackSessionStore.js";

export interface AdapterInboundRuntimeDeps {
  state: AdapterConnectionState;
  getSessionStore: () => ReturnType<typeof useTurnPlaybackSessionStore> | undefined;
  getHistoryAdapter: () => ReturnType<typeof useAdapterHistory> | null;
  getMotionTuningAdapter: () => ReturnType<typeof useAdapterMotionTuning> | null;
  getModelSyncAdapter: () => ReturnType<typeof useModelSync> | null;
  pushHistory: (role: string, text: string) => void;
  stopAudioAndSettleTurn: (turnId: string | null, reason: string) => void;
  resetAudioPlaybackTerminal: () => void;
  markAudioPlaybackTerminal: (
    terminalState: "completed" | "failed" | "absent",
    turnId: string | null,
    reason?: string,
    messageId?: string | null,
  ) => void;
  hasPendingAudioForTurn: (turnId: string | null) => boolean;
  markMissingAudiosForTurn: (turnId: string | null, reason: string) => void;
  queueAudioForPlayback: (
    url: string,
    turnId: string | null,
    messageId: string,
  ) => void;
  findActiveAudioSegment: () => { turnId: string | null; messageId: string } | null;
  playMotionPreviewPayload?: (payload: unknown) => boolean;
  startMicrophoneCapture: (origin?: "manual" | "ptt" | "auto") => Promise<boolean>;
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

  function hasPlaybackSegment(turnId: string | null, messageId: string): boolean {
    const sessionStore = deps.getSessionStore();
    const session = sessionStore?.getSession(turnId);
    return Boolean(session?.segments.has(messageId));
  }

  function canAcceptOutputSegment(turnId: string | null, messageId: string): boolean {
    const sessionStore = deps.getSessionStore();
    const session = sessionStore?.getSession(turnId);
    if (!session) {
      return true;
    }
    if (session.segments.has(messageId)) {
      return true;
    }
    return !session.backend.synthFinished;
  }

  function canQueuePendingMotionForTurn(turnId: string | null): boolean {
    const sessionStore = deps.getSessionStore();
    const session = sessionStore?.getSession(turnId);
    return Boolean(session && !session.backend.synthFinished);
  }

  function queuePendingMotionForSegment(
    turnId: string | null,
    messageId: string,
    payload: NormalizedMotionPayload,
  ): void {
    deps.state.pendingMotions.set(buildPendingPlaybackKey(turnId, messageId), {
      turnId,
      messageId,
      payload,
      receivedAtMs: performance.now(),
    });
    deps.state.statusMessage = "动作载荷先于同段输出到达，已暂存等待配对。";
  }

  function flushPendingMotionForSegment(
    turnId: string | null,
    messageId: string,
  ): void {
    const key = buildPendingPlaybackKey(turnId, messageId);
    const pending = deps.state.pendingMotions.get(key);
    if (!pending || !hasPlaybackSegment(turnId, messageId)) {
      return;
    }
    deps.state.pendingMotions.delete(key);
    deps.getSessionStore()?.markMotionReceived(
      pending.turnId,
      pending.payload,
      pending.messageId,
    );
  }

  function clearPendingMotionsForTurn(turnId: string | null, reason: string): void {
    for (const [key, pending] of Array.from(deps.state.pendingMotions.entries())) {
      if (!matchesPendingTurn(pending.turnId, turnId)) {
        continue;
      }
      deps.state.pendingMotions.delete(key);
      const message = `动作载荷缺少同段输出，已拒绝（turn_id=${turnId ?? "null"}, message_id=${pending.messageId}, reason=${reason}）。`;
      deps.state.lastError = message;
      deps.state.statusMessage = message;
      deps.pushHistory("error", message);
      console.warn("[Connection] rejected orphan motion payload.", {
        turnId,
        messageId: pending.messageId,
        reason,
        receivedAtMs: pending.receivedAtMs,
      });
    }
  }

  function rejectSegmentPatchWithoutOutput(
    kind: string,
    turnId: string | null,
    messageId: string,
  ): void {
    const message = `${kind}缺少同段输出，已拒绝（turn_id=${turnId ?? "null"}, message_id=${messageId}）。`;
    deps.state.lastError = message;
    deps.state.statusMessage = message;
    deps.pushHistory("error", message);
    console.warn("[Connection] rejected segment patch without output segment.", {
      kind,
      turnId,
      messageId,
    });
  }

  function rejectOutputAfterSynthFinished(
    kind: string,
    turnId: string | null,
    messageId: string,
  ): void {
    const message = `${kind}在语音合成完成后创建新输出段，已拒绝（turn_id=${turnId ?? "null"}, message_id=${messageId}）。`;
    deps.state.lastError = message;
    deps.state.statusMessage = message;
    deps.pushHistory("error", message);
    console.warn("[Connection] rejected output segment after synth finished.", {
      kind,
      turnId,
      messageId,
    });
  }

  function matchesPendingTurn(
    candidateTurnId: string | null,
    targetTurnId: string | null,
  ): boolean {
    if (matchesPlaybackGroup(candidateTurnId, targetTurnId)) {
      return true;
    }
    return !candidateTurnId && !targetTurnId;
  }

  async function dispatchInboundEvent(
    event: InboundAdapterEvent,
  ): Promise<void> {
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
            markTextReceived: (tId, text, msgId, mode, audioExpected) =>
              sessionStore.markTextReceived(
                tId,
                text,
                msgId,
                mode as "replace" | "append",
                audioExpected,
              ),
            markTextDelivered: (tId, msgId) => sessionStore.markTextDelivered(tId, msgId),
            markAudioReceived: (tId, url, msgId, captionText) =>
              sessionStore.markAudioReceived(tId, url, msgId, captionText),
            markAudioTerminal: (tId, terminal, msgId, reason) => sessionStore.markAudioTerminal(tId, terminal as "completed" | "failed" | "absent", msgId, reason),
            markMotionReceived: (tId, payload, msgId) => sessionStore.markMotionReceived(tId, payload as NormalizedMotionPayload, msgId),
            markPerformanceCurveHintReceived: (tId, hint, msgId) => sessionStore.markPerformanceCurveHintReceived(tId, hint, msgId),
            canAcceptOutputSegment,
            ensureSegment: (tId, msgId) => sessionStore.ensureSegment(tId, msgId),
            getSessions: () => sessionStore.getSessions(),
          }
        : undefined,
      pushHistory: deps.pushHistory,
      modelSyncAdapter: modelSyncAdapter
        ? {
            applyUnknownMessage: (env) => modelSyncAdapter.applyUnknownMessage(env),
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
      rewriteModelSyncEnvelope: (env) => rewriteModelSyncEnvelope(env),
      rewriteSocketUrl: (url) => rewriteSocketUrl(url),
      rewriteHttpUrl: (url) => rewriteHttpUrl(url),
      stopAudioAndSettleTurn: (turnId, reason) =>
        deps.stopAudioAndSettleTurn(turnId, reason),
      resetAudioPlaybackTerminal: () => deps.resetAudioPlaybackTerminal(),
      markAudioPlaybackTerminal: (terminalState, turnId, reason, messageId) =>
        deps.markAudioPlaybackTerminal(
          terminalState as "completed" | "failed" | "absent",
          turnId,
          reason,
          messageId,
        ),
      hasPendingAudioForTurn: (turnId) => deps.hasPendingAudioForTurn(turnId),
      markMissingAudiosForTurn: (turnId, reason) => deps.markMissingAudiosForTurn(turnId, reason),
      clearPendingMotionsForTurn,
      reportRuntimeProtocolViolation,
      queuePendingAssistantTextForPlayback: (map, text, turnId, messageId) =>
        queuePendingAssistantTextForPlayback(map, text, turnId, messageId),
      queuePendingAudioForPlayback: (map, url, turnId, messageId) => {
        if (map === deps.state.pendingAudios) {
          deps.queueAudioForPlayback(url, turnId, messageId);
          return;
        }
        map.set(buildPendingPlaybackKey(turnId, messageId), {
          audioUrl: url,
          turnId,
          messageId,
          receivedAtMs: performance.now(),
        });
      },
      flushPendingMotionForSegment,
      rejectSegmentPatchWithoutOutput,
      rejectOutputAfterSynthFinished,
      findActiveAudioSegment: () => deps.findActiveAudioSegment(),
      playMotionPreviewPayload: deps.playMotionPreviewPayload,
      hasPlaybackSegment,
      canQueuePendingMotionForTurn,
      queuePendingMotionForSegment,
      normalizeMotionPayload: (payload) => normalizeMotionPayload(payload),
      applyInboundMotionPayload: (ctx, envelope) =>
        applyInboundMotionPayload(ctx, envelope),
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
