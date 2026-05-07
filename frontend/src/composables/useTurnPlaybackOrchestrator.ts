import { onScopeDispose, watch } from "vue";
import type { useAdapterConnection } from "./useAdapterConnection";
import type { useModelEngine } from "../model-engine/useModelEngine";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import type { NormalizedMotionPayload } from "../model-engine/contracts";
import {
  createTurnPlaybackOrchestratorCore,
  type TurnPlaybackReleaseContext,
} from "./turnPlaybackOrchestratorCore";
import { orchestrationIdFromSessionId } from "../turn-playback/session.js";
import {
  canReleaseAudio,
  canReleaseMotion,
  canReleaseText,
} from "../turn-playback/selectors.js";

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
    releaseText: (turnId, orchestrationId) => {
      const released = options.adapter.releaseAssistantTextForPlayback(
        turnId,
        orchestrationId,
      );
      if (released) {
        options.sessionStore.markTextReleased(orchestrationId, turnId);
        options.sessionStore.markPhase(orchestrationId, turnId, "playing");
      }
      return released;
    },
    releaseAudio: (turnId, orchestrationId) => {
      void options.adapter.releaseAudioForPlayback(turnId, orchestrationId);
    },
    releaseMotion: (payload: unknown, context: TurnPlaybackReleaseContext) => {
      options.sessionStore.markMotionReleased(
        context.orchestrationId,
        context.turnId,
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
    () => options.sessionStore.getSessions().map((session) => ({
      id: session.id,
      turnId: session.turnId,
      phase: session.phase,
      textContent: session.text.content,
      textReleased: session.text.released,
      audioUrl: session.audio.url,
      audioTerminal: session.audio.terminal,
      motionReceivedAtMs: session.motion.receivedAtMs,
      motionReleased: session.motion.released,
      hasMotionPayload: session.motion.payload !== null,
      backendTurnFinished: session.backend.turnFinished,
    })),
    () => {
      for (const session of options.sessionStore.getSessions()) {
        const orchestrationId = orchestrationIdFromSessionId(session.id);

        if (
          session.phase === "collecting"
          && session.text.content
        ) {
          options.sessionStore.markPhase(orchestrationId, session.turnId, "ready");
        }

        if (canReleaseText(session)) {
          core.markTextReady(session.turnId, orchestrationId);
        }

        if (canReleaseAudio(session)) {
          core.markAudioReady(session.turnId, orchestrationId);
        }

        if (session.audio.terminal === "absent") {
          core.markNoAudioConfirmed(session.turnId, orchestrationId);
        }

        if (canReleaseMotion(session) && session.motion.payload) {
          core.markMotionReady(
            session.turnId,
            orchestrationId,
            session.motion.payload,
            session.motion.receivedAtMs ?? performance.now(),
          );
        }

        if (session.backend.turnFinished) {
          core.markTurnFinished(session.turnId, orchestrationId);
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
