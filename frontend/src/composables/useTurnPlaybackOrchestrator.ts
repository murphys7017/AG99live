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
      options.modelEngine.ingestNormalizedPayload(
        payload as NormalizedMotionPayload,
        context,
      );
      options.sessionStore.markMotionStarted(
        context.orchestrationId,
        context.turnId,
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

  // Text: when content appears and not yet released
  watch(
    () => {
      const s = options.sessionStore.getActiveSession();
      if (!s) return null;
      return `${s.id}|${s.text.content ?? "__nil__"}|${s.text.released}`;
    },
    (key) => {
      if (!key) return;
      const s = options.sessionStore.getActiveSession();
      if (!s || !s.text.content || s.text.released) return;
      core.markTextReady(
        s.turnId,
        orchestrationIdFromSessionId(s.id),
      );
    },
  );

  // Audio: when url appears
  watch(
    () => {
      const s = options.sessionStore.getActiveSession();
      if (!s) return null;
      return s.audio.url ? `${s.id}|${s.audio.url}` : null;
    },
    (key) => {
      if (!key) return;
      const s = options.sessionStore.getActiveSession();
      if (!s) return;
      core.markAudioReady(
        s.turnId,
        orchestrationIdFromSessionId(s.id),
      );
    },
  );

  // Audio absent: when terminal becomes "absent"
  watch(
    () => {
      const s = options.sessionStore.getActiveSession();
      if (!s) return null;
      return s.audio.terminal === "absent" ? `${s.id}|absent` : null;
    },
    (key) => {
      if (!key) return;
      const s = options.sessionStore.getActiveSession();
      if (!s) return;
      core.markNoAudioConfirmed(
        s.turnId,
        orchestrationIdFromSessionId(s.id),
      );
    },
  );

  // Motion: when payload appears and not yet started
  watch(
    () => {
      const s = options.sessionStore.getActiveSession();
      if (!s || !s.motion.payload || s.motion.started) return null;
      return `${s.id}|${s.motion.receivedAtMs}`;
    },
    (key) => {
      if (!key) return;
      const s = options.sessionStore.getActiveSession();
      if (!s) return;
      core.markMotionReady(
        s.turnId,
        orchestrationIdFromSessionId(s.id),
        s.motion.payload,
        s.motion.receivedAtMs ?? performance.now(),
      );
    },
  );

  // Backend turn_finished
  watch(
    () => {
      const s = options.sessionStore.getActiveSession();
      if (!s || !s.backend.turnFinished) return null;
      return `${s.id}|finished`;
    },
    (key) => {
      if (!key) return;
      const s = options.sessionStore.getActiveSession();
      if (!s) return;
      core.markTurnFinished(
        s.turnId,
        orchestrationIdFromSessionId(s.id),
      );

      // Auto-advance phase: collecting → ready when text is present
      if (s.text.content && s.phase === "collecting") {
        options.sessionStore.markPhase(
          orchestrationIdFromSessionId(s.id),
          s.turnId,
          "ready",
        );
      }
    },
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
