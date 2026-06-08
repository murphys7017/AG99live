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
}

export function createMotionRuntimeScheduler(
  dependencies: MotionRuntimeSchedulerDependencies,
  hooks: MotionRuntimeSchedulerHooks,
) {
  const pendingInboundMotionPayloads = new Map<string, PendingInboundMotionPayload>();

  function syncPendingState(): void {
    hooks.onPendingStateChanged(
      pendingInboundMotionPayloads.size,
      pendingInboundMotionPayloads.keys().next().value ?? "",
    );
  }

  function clearPendingPayload(entry: PendingInboundMotionPayload): void {
    window.clearTimeout(entry.audioWaitTimer);
  }

  function clearAllPendingPayloads(): void {
    for (const entry of pendingInboundMotionPayloads.values()) {
      clearPendingPayload(entry);
    }
    pendingInboundMotionPayloads.clear();
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
        if (normalizedMessageId) {
          if (segment.messageId === normalizedMessageId) {
            return segment;
          }
          continue;
        }
        const segmentTurnId = normalizeTurnId(segment.turnId);
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

  function tryStartPendingPayload(messageId: string, startReason: string): boolean {
    const entry = pendingInboundMotionPayloads.get(messageId);
    if (!entry) {
      return false;
    }

    pendingInboundMotionPayloads.delete(messageId);
    clearPendingPayload(entry);
    syncPendingState();
    return hooks.onStartPayload(entry.payload, {
      turnId: entry.turnId,
      playbackTurnId: entry.playbackTurnId,
      messageId: entry.messageId,
      startReason,
      queuedDelayMs: Math.max(0, Math.round(performance.now() - entry.receivedAtMs)),
    });
  }

  function queueInboundPayload(
    payload: NormalizedMotionPayload,
    context: InboundPayloadContext,
  ): void {
    const normalizedTurnId = normalizeTurnId(context.turnId);
    const normalizedPlaybackTurnId =
      normalizeTurnId(context.playbackTurnId ?? null) ?? normalizedTurnId;
    if (!normalizedTurnId) {
      hooks.onStartPayload(payload, {
        messageId: context.messageId,
        turnId: null,
        playbackTurnId: normalizedPlaybackTurnId,
        startReason: "missing_turn_id",
        queuedDelayMs: 0,
      });
      return;
    }

    const existing = pendingInboundMotionPayloads.get(context.messageId);
    if (existing) {
      console.info("[ModelEngine] replacing pending motion payload for turn.", {
        turnId: normalizedTurnId,
        messageId: context.messageId,
      });
      clearPendingPayload(existing);
      pendingInboundMotionPayloads.delete(context.messageId);
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
      const latest = pendingInboundMotionPayloads.get(context.messageId);
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
          tryStartPendingPayload(context.messageId, "wait_audio_timeout_playback_turn_match");
          return;
        }
        clearPendingPayload(entry);
        pendingInboundMotionPayloads.delete(context.messageId);
        syncPendingState();
        return;
      }

      tryStartPendingPayload(context.messageId, "wait_audio_timeout");
    }, MOTION_SYNC_WAIT_FOR_AUDIO_MS);

    pendingInboundMotionPayloads.set(context.messageId, entry);
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
      tryStartPendingPayload(context.messageId, "audio_already_playing");
    }
  }

  function notifyAudioPlaybackStarted(
    turnId: string | null,
    messageId: string | null = null,
  ): void {
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    if (normalizedMessageId) {
      const started = tryStartPendingPayload(normalizedMessageId, "audio_playing_event");
      console.info("[ModelEngine] audio playback start notification handled.", {
        turnId,
        messageId: normalizedMessageId,
        started,
        pendingCount: pendingInboundMotionPayloads.size,
      });
      return;
    }
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedTurnId) {
      return;
    }
    let started = false;
    for (const entry of Array.from(pendingInboundMotionPayloads.values())) {
      if (entry.turnId === normalizedTurnId) {
        started = tryStartPendingPayload(entry.messageId, "audio_playing_event") || started;
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

    for (const [messageId, entry] of pendingInboundMotionPayloads.entries()) {
      if (entry.turnId === currentTurnId) {
        continue;
      }
      clearPendingPayload(entry);
      pendingInboundMotionPayloads.delete(messageId);
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
