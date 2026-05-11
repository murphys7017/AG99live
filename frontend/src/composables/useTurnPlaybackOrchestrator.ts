import { onScopeDispose, watch } from "vue";
import type { useAdapterConnection } from "./useAdapterConnection";
import type { useModelEngine } from "../model-engine/useModelEngine";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import type { NormalizedMotionPayload } from "../model-engine/contracts";
import {
  createTurnPlaybackOrchestratorCore,
  type TurnPlaybackReleaseContext,
} from "./turnPlaybackOrchestratorCore.js";
import {
  canReleaseAudio,
  canReleaseMotion,
  canReleaseText,
  getActivePlaybackSegment,
} from "../turn-playback/selectors.js";
import { isSegmentLocallySettled } from "../turn-playback/session.js";

type AdapterConnection = ReturnType<typeof useAdapterConnection>;
type ModelEngine = ReturnType<typeof useModelEngine>;
type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

interface TurnPlaybackOrchestratorOptions {
  sessionStore: SessionStore;
  adapter: AdapterConnection;
  modelEngine: ModelEngine;
}

export function useTurnPlaybackOrchestrator(
  options: TurnPlaybackOrchestratorOptions,
) {
  const core = createTurnPlaybackOrchestratorCore({
    now: () => performance.now(),
    schedule: (delayMs, fn) => window.setTimeout(fn, delayMs),
    clearSchedule: (timer) => {
      window.clearTimeout(timer as number);
    },
    releaseText: (messageId, turnId, orchestrationId) => {
      const released = options.adapter.releaseAssistantTextForPlayback(
        messageId,
        turnId,
        orchestrationId,
      );
      if (released) {
        options.sessionStore.markTextReleased(orchestrationId, turnId, messageId);
        options.sessionStore.markPhase(orchestrationId, turnId, "playing");
      }
      return released;
    },
    releaseAudio: (messageId, turnId, orchestrationId) => {
      const released = options.adapter.releaseAudioForPlayback(
        messageId,
        turnId,
        orchestrationId,
      );
      if (released) {
        options.sessionStore.markAudioReleased(orchestrationId, turnId, messageId);
      }
      return released;
    },
    releaseMotion: (payload: unknown, context: TurnPlaybackReleaseContext) => {
      options.sessionStore.markMotionReleased(
        context.orchestrationId,
        context.turnId,
        context.messageId,
      );
      options.modelEngine.ingestNormalizedPayload(
        payload as NormalizedMotionPayload,
        context,
      );
      options.sessionStore.markPhase(
        context.orchestrationId,
        context.turnId,
        "playing",
      );
    },
    log: (message, details) => {
      console.info(`[TurnPlaybackOrchestrator] ${message}.`, details);
    },
  });

  // ── Watch session state and feed to core ────────────────────────

  watch(
    () => options.sessionStore.getSessions().flatMap((session) =>
      session.segmentOrder.map((segmentId) => {
        const segment = session.segments.get(segmentId);
        const activeSegment = getActivePlaybackSegment(session);
        return {
          sessionId: session.id,
          sessionPhase: session.phase,
          backendSynthFinished: session.backend.synthFinished,
          activeSegmentId: activeSegment?.messageId ?? null,
          segmentId,
          turnId: segment?.turnId ?? null,
          orchestrationId: segment?.orchestrationId ?? null,
          textContent: segment?.text.content ?? null,
          textReleased: segment?.text.released ?? false,
          textDelivered: segment?.text.delivered ?? false,
          audioUrl: segment?.audio.url ?? null,
          audioReleased: segment?.audio.released ?? false,
          audioTerminal: segment?.audio.terminal ?? "idle",
          motionReceivedAtMs: segment?.motion.receivedAtMs ?? null,
          motionReleased: segment?.motion.released ?? false,
          motionCompleted: segment?.motion.completed ?? false,
          motionAbsent: segment?.motion.absent ?? false,
          hasMotionPayload: segment?.motion.payload !== null,
        };
      }),
    ),
    () => {
      for (const session of options.sessionStore.getSessions()) {
        for (const segmentId of session.segmentOrder) {
          const candidate = session.segments.get(segmentId);
          if (candidate && isSegmentLocallySettled(candidate)) {
            core.clearSegment(candidate.messageId);
          }
        }

        const segment = getActivePlaybackSegment(session);
        if (!segment) {
          continue;
        }

        if (session.phase === "collecting" && segment.text.content) {
          options.sessionStore.markPhase(
            segment.orchestrationId,
            segment.turnId,
            "ready",
          );
        }

        if (canReleaseText(segment)) {
          core.markTextReady(segment.messageId, segment.turnId, segment.orchestrationId);
        }

        if (canReleaseAudio(segment)) {
          core.markAudioReady(segment.messageId, segment.turnId, segment.orchestrationId);
        }

        if (segment.audio.terminal === "absent") {
          core.markNoAudioConfirmed(
            segment.messageId,
            segment.turnId,
            segment.orchestrationId,
          );
        }

        if (canReleaseMotion(segment) && segment.motion.payload) {
          core.markMotionReady(
            segment.messageId,
            segment.turnId,
            segment.orchestrationId,
            segment.motion.payload,
            segment.motion.receivedAtMs ?? performance.now(),
          );
        }

        if (session.backend.synthFinished) {
          core.markOutputQueueClosed(
            segment.messageId,
            segment.turnId,
            segment.orchestrationId,
          );
        }
      }
    },
    { deep: true },
  );

  // Active session changed → flush stale groups
  watch(
    () => options.sessionStore.state.activeSessionId,
    () => {
      core.flush();
    },
  );

  // Forward turn changes to model engine
  watch(
    () => options.sessionStore.state.activeSessionId,
    (sessionId) => {
      const s = sessionId
        ? options.sessionStore.state.sessions.get(sessionId)
        : undefined;
      options.modelEngine.notifyCurrentTurnChanged(s?.turnId ?? null);
    },
  );

  onScopeDispose(() => {
    core.clear();
  });

  return {
    flush: () => {
      core.flush();
    },
  };
}
