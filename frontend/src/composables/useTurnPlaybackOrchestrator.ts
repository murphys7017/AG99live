import { onScopeDispose, watch } from "vue";
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
import type {
  MotionPayloadPort,
  PlaybackReleasePort,
} from "../turn-playback/ports.js";

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

interface TurnPlaybackOrchestratorOptions {
  sessionStore: SessionStore;
  playbackRelease: PlaybackReleasePort;
  motionPayload: MotionPayloadPort;
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
    releaseText: (messageId, turnId) => {
      const released = options.playbackRelease.releaseAssistantTextForPlayback(
        messageId,
        turnId,
      );
      if (released) {
        options.sessionStore.markTextReleased(turnId, messageId);
        options.sessionStore.markPhase(turnId, "playing");
      }
      return released;
    },
    releaseAudio: (messageId, turnId) => {
      const released = options.playbackRelease.releaseAudioForPlayback(
        messageId,
        turnId,
      );
      if (released) {
        options.sessionStore.markAudioReleased(turnId, messageId);
      }
      return released;
    },
    releaseMotion: (payload: unknown, context: TurnPlaybackReleaseContext) => {
      options.sessionStore.markMotionReleased(
        context.turnId,
        context.messageId,
      );
      options.motionPayload.ingestNormalizedPayload(
        payload as NormalizedMotionPayload,
        context,
      );
      options.sessionStore.markPhase(
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
        if (session.phase === "completed" || session.phase === "failed") {
          for (const segmentId of session.segmentOrder) {
            core.clearSegment(segmentId);
          }
          continue;
        }

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
          options.sessionStore.markPhase(segment.turnId, "ready");
        }

        if (canReleaseText(segment)) {
          core.markTextReady(segment.messageId, segment.turnId);
        }

        if (canReleaseAudio(segment)) {
          core.markAudioReady(segment.messageId, segment.turnId);
        }

        if (segment.audio.terminal === "absent") {
          core.markNoAudioConfirmed(
            segment.messageId,
            segment.turnId,
          );
        }

        if (canReleaseMotion(segment) && segment.motion.payload) {
          core.markMotionReady(
            segment.messageId,
            segment.turnId,
            segment.motion.payload,
            segment.motion.receivedAtMs ?? performance.now(),
          );
        }

        if (session.backend.synthFinished) {
          core.markOutputQueueClosed(
            segment.messageId,
            segment.turnId,
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
      options.motionPayload.notifyCurrentTurnChanged(s?.turnId ?? null);
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
