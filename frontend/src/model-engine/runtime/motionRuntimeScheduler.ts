import {
  MOTION_SYNC_WAIT_FOR_AUDIO_MS,
} from "../constants.js";
import type {
  NormalizedMotionPayload,
} from "../contracts.js";
import type {
  InboundPayloadContext,
  MotionRuntimeSchedulerDependencies,
} from "./contracts.js";
import type { PlaybackTimelineSnapshot } from "../../playback-timeline/contracts.js";
import { normalizeTurnId } from "../normalize.js";

export interface PendingInboundMotionPayload {
  payload: NormalizedMotionPayload;
  messageId: string;
  turnId: string;
  playbackTurnId: string | null;
  receivedAtMs: number;
  playbackTimeline: PlaybackTimelineSnapshot | null;
  audioWaitTimer: number;
}

export interface StartPayloadContext {
  messageId: string;
  turnId: string | null;
  playbackTurnId: string | null;
  startReason: string;
  queuedDelayMs: number;
  playbackTimeline?: PlaybackTimelineSnapshot | null;
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

function hasPerformanceCurveHint(payload: NormalizedMotionPayload): boolean {
  return (
    payload.kind === "semantic_intent"
    && payload.intent.performance_curve_hint?.schema_version === "ag99.performance_curve_hint.v1"
  );
}

function matchesPlaybackTimeline(
  entry: PendingInboundMotionPayload,
  snapshot: PlaybackTimelineSnapshot,
): boolean {
  return (
    entry.messageId === snapshot.messageId
    && normalizeTurnId(entry.turnId) === normalizeTurnId(snapshot.turnId)
  );
}

function canStartFromPlaybackTimeline(
  snapshot: PlaybackTimelineSnapshot,
): boolean {
  if (snapshot.clockSource === "synthetic") {
    return true;
  }
  return (
    snapshot.clockSource === "audio"
    && (snapshot.phase === "playing" || snapshot.phase === "paused")
  );
}

function isTimelineUnavailable(
  snapshot: PlaybackTimelineSnapshot,
): boolean {
  return snapshot.clockSource === "audio_unavailable";
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
      playbackTimeline: entry.playbackTimeline,
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

  function tryStartPendingPayload(
    turnId: string | null,
    messageId: string,
    startReason: string,
    playbackTimeline: PlaybackTimelineSnapshot | null = null,
  ): boolean {
    const key = buildPendingMotionKey(turnId, messageId);
    const entry = pendingInboundMotionPayloads.get(key);
    if (!entry) {
      return false;
    }

    if (playbackTimeline && matchesPlaybackTimeline(entry, playbackTimeline)) {
      entry.playbackTimeline = playbackTimeline;
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

  function failPendingPayloadForTimeline(
    snapshot: PlaybackTimelineSnapshot,
    reason: string,
  ): boolean {
    const key = buildPendingMotionKey(snapshot.turnId, snapshot.messageId);
    const entry = pendingInboundMotionPayloads.get(key);
    if (!entry) {
      return false;
    }
    dropPendingPayload(entry, reason);
    syncPendingState();
    return true;
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
        playbackTimeline: context.playbackTimeline ?? null,
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
      playbackTimeline: context.playbackTimeline ?? null,
      audioWaitTimer: 0,
    };

    if (entry.playbackTimeline && !matchesPlaybackTimeline(entry, entry.playbackTimeline)) {
      hooks.onStartFailed?.({
        messageId: entry.messageId,
        turnId: entry.turnId,
        playbackTurnId: entry.playbackTurnId,
        startReason: "playback_timeline_identity_mismatch",
        queuedDelayMs: 0,
        playbackTimeline: entry.playbackTimeline,
      });
      return;
    }

    entry.audioWaitTimer = window.setTimeout(() => {
      const latest = pendingInboundMotionPayloads.get(pendingKey);
      if (!latest || latest !== entry) {
        return;
      }

      const activeSession = dependencies.sessionStore?.getActiveSession();
      const currentTurnId = normalizeTurnId(
        activeSession?.turnId ?? dependencies.getCurrentTurnId(),
      );

      if (currentTurnId && currentTurnId !== normalizedTurnId) {
        dropPendingPayload(entry, "stale_turn_dropped");
        syncPendingState();
        return;
      }

      dropPendingPayload(
        entry,
        hasPerformanceCurveHint(entry.payload)
          ? "playback_timeline_missing_before_curve_motion_start"
          : "playback_timeline_missing_before_motion_start",
      );
      syncPendingState();
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

    if (entry.playbackTimeline) {
      if (isTimelineUnavailable(entry.playbackTimeline)) {
        failPendingPayloadForTimeline(
          entry.playbackTimeline,
          "playback_timeline_audio_unavailable_before_motion_start",
        );
        return;
      }
      if (canStartFromPlaybackTimeline(entry.playbackTimeline)) {
        tryStartPendingPayload(
          entry.turnId,
          entry.messageId,
          entry.playbackTimeline.clockSource === "synthetic"
            ? "motion_only_timeline_ready"
            : "playback_timeline_ready",
          entry.playbackTimeline,
        );
      }
    }
  }

  function handlePlaybackTimelineStarted(
    playbackTimeline: PlaybackTimelineSnapshot,
  ): boolean {
    if (!canStartFromPlaybackTimeline(playbackTimeline)) {
      if (isTimelineUnavailable(playbackTimeline)) {
        return failPendingPayloadForTimeline(
          playbackTimeline,
          "playback_timeline_audio_unavailable_before_motion_start",
        );
      }
      return false;
    }
    const started = tryStartPendingPayload(
      playbackTimeline.turnId,
      playbackTimeline.messageId,
      "playback_timeline_started",
      playbackTimeline,
    );
    console.info("[ModelEngine] playback timeline start handled.", {
      turnId: playbackTimeline.turnId,
      messageId: playbackTimeline.messageId,
      timelineId: playbackTimeline.timelineId,
      started,
      pendingCount: pendingInboundMotionPayloads.size,
    });
    return started;
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
    handlePlaybackTimelineStarted,
    notifyCurrentTurnChanged,
    clearAllPendingPayloads,
  };
}
