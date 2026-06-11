import {
  MOTION_MIN_REMAINING_AUDIO_MS,
  MOTION_SYNC_WAIT_FOR_AUDIO_MS,
} from "../constants.js";
import type {
  NormalizedMotionPayload,
} from "../contracts.js";
import type {
  InboundPayloadContext,
  MotionRuntimeSchedulerDependencies,
} from "./contracts.js";
import { normalizeTurnId } from "../normalize.js";

export interface PendingInboundMotionPayload {
  payload: NormalizedMotionPayload;
  messageId: string;
  turnId: string;
  playbackTurnId: string | null;
  receivedAtMs: number;
  audioWaitTimer: number;
}

export interface StartPayloadContext {
  messageId: string;
  turnId: string | null;
  playbackTurnId: string | null;
  startReason: string;
  queuedDelayMs: number;
}

interface MotionRuntimeSchedulerHooks {
  onPendingStateChanged: (pendingCount: number, pendingMessageId: string) => void;
  onPendingStatus: (message: string) => void;
  onStartPayload: (
    payload: NormalizedMotionPayload,
    context: StartPayloadContext,
  ) => boolean;
  onStartFailed?: (context: StartPayloadContext) => void;
}

export function createMotionRuntimeScheduler(
  dependencies: MotionRuntimeSchedulerDependencies,
  hooks: MotionRuntimeSchedulerHooks,
) {
  const pendingInboundMotionPayloads = new Map<string, PendingInboundMotionPayload>();

  function buildPendingMotionKey(
    turnId: string | null,
    messageId: string,
  ): string {
    const normalizedTurnId = normalizeTurnId(turnId) ?? "anonymous";
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    if (!normalizedMessageId) {
      throw new Error("Pending motion payload requires a non-empty messageId.");
    }
    return `${normalizedTurnId}::${normalizedMessageId}`;
  }

  function syncPendingState(): void {
    hooks.onPendingStateChanged(
      pendingInboundMotionPayloads.size,
      pendingInboundMotionPayloads.values().next().value?.messageId ?? "",
    );
  }

  function clearPendingPayload(entry: PendingInboundMotionPayload): void {
    window.clearTimeout(entry.audioWaitTimer);
  }

  function buildStartContext(
    entry: PendingInboundMotionPayload,
    startReason: string,
  ): StartPayloadContext {
    return {
      turnId: entry.turnId,
      playbackTurnId: entry.playbackTurnId,
      messageId: entry.messageId,
      startReason,
      queuedDelayMs: Math.max(0, Math.round(performance.now() - entry.receivedAtMs)),
    };
  }

  function dropPendingPayload(
    entry: PendingInboundMotionPayload,
    startReason: string,
  ): void {
    clearPendingPayload(entry);
    pendingInboundMotionPayloads.delete(buildPendingMotionKey(entry.turnId, entry.messageId));
    hooks.onStartFailed?.(buildStartContext(entry, startReason));
  }

  function clearAllPendingPayloads(): void {
    for (const entry of Array.from(pendingInboundMotionPayloads.values())) {
      dropPendingPayload(entry, "motion_engine_stopped");
    }
    syncPendingState();
  }

  function findStartedSegment(
    messageId: string | null,
    turnId: string | null,
    playbackTurnId: string | null = null,
  ) {
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    const normalizedTurnId = normalizeTurnId(turnId);
    const normalizedPlaybackTurnId = normalizeTurnId(playbackTurnId);

    for (const session of [
      dependencies.sessionStore?.getActiveSession(),
      dependencies.sessionStore?.getSessionByTurnId?.(turnId),
    ]) {
      if (!session) {
        continue;
      }
      for (const segmentId of session.segmentOrder) {
        const segment = session.segments.get(segmentId);
        if (!segment || !segment.audio.started || segment.audio.terminal !== "idle") {
          continue;
        }
        const segmentTurnId = normalizeTurnId(segment.turnId);
        if (normalizedMessageId) {
          const turnMatches = Boolean(
            (normalizedTurnId && segmentTurnId === normalizedTurnId)
            || (normalizedPlaybackTurnId && segmentTurnId === normalizedPlaybackTurnId),
          );
          if (
            segment.messageId === normalizedMessageId
            && (!normalizedTurnId && !normalizedPlaybackTurnId || turnMatches)
          ) {
            return segment;
          }
          continue;
        }
        if (normalizedTurnId && segmentTurnId === normalizedTurnId) {
          return segment;
        }
        if (normalizedPlaybackTurnId && segmentTurnId === normalizedPlaybackTurnId) {
          return segment;
        }
      }
    }
    return null;
  }

  function resolveMotionTargetDurationMs(
    messageId: string | null,
    turnId: string | null,
    playbackTurnId: string | null = null,
  ): number | null {
    const startedSegment = findStartedSegment(messageId, turnId, playbackTurnId);
    const audioStartedAtMs = startedSegment?.audio.startedAtMs;
    const audioDurationMs = startedSegment?.audio.durationMs;
    const sessionTurnId = startedSegment?.turnId;

    const normalizedTurnId = normalizeTurnId(turnId);
    const normalizedSessionTurnId = normalizeTurnId(sessionTurnId ?? null);

    if (
      (!normalizedTurnId || !normalizedSessionTurnId || normalizedTurnId === normalizedSessionTurnId)
      && audioStartedAtMs
      && audioDurationMs
      && Number.isFinite(audioStartedAtMs)
      && audioStartedAtMs > 0
      && Number.isFinite(audioDurationMs)
      && audioDurationMs > 0
    ) {
      const elapsedMs = Math.max(0, performance.now() - audioStartedAtMs);
      return Math.max(MOTION_MIN_REMAINING_AUDIO_MS, Math.round(audioDurationMs - elapsedMs));
    }

    return null;
  }

  function isSpeechActiveForPayload(
    messageId: string | null,
    turnId: string | null,
    playbackTurnId: string | null = null,
  ): boolean {
    return findStartedSegment(messageId, turnId, playbackTurnId) !== null;
  }

  function tryStartPendingPayload(
    turnId: string | null,
    messageId: string,
    startReason: string,
  ): boolean {
    const key = buildPendingMotionKey(turnId, messageId);
    const entry = pendingInboundMotionPayloads.get(key);
    if (!entry) {
      return false;
    }

    pendingInboundMotionPayloads.delete(key);
    clearPendingPayload(entry);
    syncPendingState();
    const context = buildStartContext(entry, startReason);
    const started = hooks.onStartPayload(entry.payload, context);
    if (!started) {
      hooks.onStartFailed?.(context);
    }
    return started;
  }

  function queueInboundPayload(
    payload: NormalizedMotionPayload,
    context: InboundPayloadContext,
  ): void {
    const normalizedTurnId = normalizeTurnId(context.turnId);
    const normalizedPlaybackTurnId =
      normalizeTurnId(context.playbackTurnId ?? null) ?? normalizedTurnId;
    if (!normalizedTurnId) {
      const startContext = {
        messageId: context.messageId,
        turnId: null,
        playbackTurnId: normalizedPlaybackTurnId,
        startReason: "missing_turn_id",
        queuedDelayMs: 0,
      };
      const started = hooks.onStartPayload(payload, startContext);
      if (!started) {
        hooks.onStartFailed?.(startContext);
      }
      return;
    }

    const pendingKey = buildPendingMotionKey(normalizedTurnId, context.messageId);
    const existing = pendingInboundMotionPayloads.get(pendingKey);
    if (existing) {
      console.info("[ModelEngine] replacing pending motion payload for turn.", {
        turnId: normalizedTurnId,
        messageId: context.messageId,
      });
      clearPendingPayload(existing);
      pendingInboundMotionPayloads.delete(pendingKey);
    }

    const entry: PendingInboundMotionPayload = {
      payload,
      messageId: context.messageId,
      turnId: normalizedTurnId,
      playbackTurnId: normalizedPlaybackTurnId,
      receivedAtMs: context.receivedAtMs,
      audioWaitTimer: 0,
    };

    entry.audioWaitTimer = window.setTimeout(() => {
      const latest = pendingInboundMotionPayloads.get(pendingKey);
      if (!latest || latest !== entry) {
        return;
      }

      const activeSession = dependencies.sessionStore?.getActiveSession();
      const currentTurnId = normalizeTurnId(
        activeSession?.turnId ?? dependencies.getCurrentTurnId(),
      );
      const currentPlaybackTurnId = currentTurnId;
      const audioPlaybackTurnId =
        normalizeTurnId(
          findStartedSegment(entry.messageId, entry.turnId, entry.playbackTurnId)?.turnId ?? null,
        );

      if (currentTurnId && currentTurnId !== normalizedTurnId) {
        if (
          entry.playbackTurnId
          && (normalizeTurnId(entry.playbackTurnId) === currentPlaybackTurnId
            || normalizeTurnId(entry.playbackTurnId) === audioPlaybackTurnId)
        ) {
          tryStartPendingPayload(entry.turnId, entry.messageId, "wait_audio_timeout_playback_turn_match");
          return;
        }
        dropPendingPayload(entry, "stale_turn_dropped");
        syncPendingState();
        return;
      }

      tryStartPendingPayload(entry.turnId, entry.messageId, "wait_audio_timeout");
    }, MOTION_SYNC_WAIT_FOR_AUDIO_MS);

    pendingInboundMotionPayloads.set(pendingKey, entry);
    syncPendingState();
    hooks.onPendingStatus("动作已排队，等待音频起播。");
    console.info("[ModelEngine] queued motion payload.", {
      kind: payload.kind,
      turnId: normalizedTurnId,
      messageId: context.messageId,
      pendingCount: pendingInboundMotionPayloads.size,
    });

    const startedSegment = findStartedSegment(
      context.messageId,
      normalizedTurnId,
      entry.playbackTurnId,
    );
    const activeAudioMessageId =
      startedSegment?.messageId
      ?? null;

    if (activeAudioMessageId === context.messageId) {
      tryStartPendingPayload(entry.turnId, entry.messageId, "audio_already_playing");
    }
  }

  function notifyAudioPlaybackStarted(
    turnId: string | null,
    messageId: string | null = null,
  ): void {
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    const normalizedTurnId = normalizeTurnId(turnId);
    if (normalizedMessageId) {
      let started = false;
      if (normalizedTurnId) {
        started = tryStartPendingPayload(
          normalizedTurnId,
          normalizedMessageId,
          "audio_playing_event",
        );
      } else {
        for (const entry of Array.from(pendingInboundMotionPayloads.values())) {
          if (entry.messageId === normalizedMessageId) {
            started = tryStartPendingPayload(
              entry.turnId,
              entry.messageId,
              "audio_playing_event",
            ) || started;
          }
        }
      }
      console.info("[ModelEngine] audio playback start notification handled.", {
        turnId,
        messageId: normalizedMessageId,
        started,
        pendingCount: pendingInboundMotionPayloads.size,
      });
      return;
    }
    if (!normalizedTurnId) {
      return;
    }
    let started = false;
    for (const entry of Array.from(pendingInboundMotionPayloads.values())) {
      if (entry.turnId === normalizedTurnId) {
        started = tryStartPendingPayload(entry.turnId, entry.messageId, "audio_playing_event") || started;
      }
    }
    console.info("[ModelEngine] audio playback start notification handled.", {
      turnId: normalizedTurnId,
      started,
      pendingCount: pendingInboundMotionPayloads.size,
    });
  }

  function notifyCurrentTurnChanged(turnId: string | null): void {
    const currentTurnId = normalizeTurnId(turnId);
    if (!currentTurnId) {
      return;
    }

    for (const entry of Array.from(pendingInboundMotionPayloads.values())) {
      if (entry.turnId === currentTurnId) {
        continue;
      }
      dropPendingPayload(entry, "current_turn_changed");
    }
    syncPendingState();
  }

  return {
    queueInboundPayload,
    notifyAudioPlaybackStarted,
    notifyCurrentTurnChanged,
    clearAllPendingPayloads,
    resolveMotionTargetDurationMs,
    isSpeechActiveForPayload,
  };
}
