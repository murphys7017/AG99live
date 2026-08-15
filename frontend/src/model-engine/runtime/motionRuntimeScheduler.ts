import type { NormalizedMotionPayload } from "../../types/motion.js";
import type {
  InboundPayloadContext,
} from "./contracts.js";
import type { MotionPlaybackClockReader } from "../contracts.js";
import type { MotionPlaybackClockContext } from "./playbackClock.js";
import { normalizeTurnId } from "../normalize.js";
import type { ModelEnginePlaybackOrigin } from "./contracts.js";

export interface PendingInboundMotionPayload {
  payload: NormalizedMotionPayload;
  messageId: string;
  turnId: string;
  assistantText: string;
  playbackTurnId: string | null;
  receivedAtMs: number;
  playbackClock: MotionPlaybackClockContext | null;
  playbackClockReader: MotionPlaybackClockReader | null;
  timelineMode: InboundPayloadContext["timelineMode"];
}

export interface StartPayloadContext {
  messageId: string;
  turnId: string | null;
  assistantText: string;
  playbackTurnId: string | null;
  playbackOrigin: ModelEnginePlaybackOrigin;
  startReason: string;
  queuedDelayMs: number;
  playbackClock?: MotionPlaybackClockContext | null;
  playbackClockReader?: MotionPlaybackClockReader | null;
}

export interface PendingMotionPreparation {
  payload: NormalizedMotionPayload;
  context: StartPayloadContext;
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

function matchesPlaybackTimeline(
  entry: PendingInboundMotionPayload,
  snapshot: MotionPlaybackClockContext,
): boolean {
  return (
    entry.messageId === snapshot.messageId
    && normalizeTurnId(entry.turnId) === normalizeTurnId(snapshot.turnId)
  );
}

function canStartFromPlaybackTimeline(
  entry: PendingInboundMotionPayload,
  snapshot: MotionPlaybackClockContext,
): boolean {
  if (snapshot.source === "synthetic") {
    return entry.timelineMode === "motion_only";
  }
  return (
    snapshot.source === "audio"
    && (snapshot.phase === "playing" || snapshot.phase === "paused")
  );
}

function isTimelineUnavailable(
  snapshot: MotionPlaybackClockContext,
): boolean {
  return snapshot.source === "audio_unavailable";
}

export function createMotionRuntimeScheduler(
  hooks: MotionRuntimeSchedulerHooks,
) {
  const pendingInboundMotionPayloads = new Map<string, PendingInboundMotionPayload>();

  function buildPendingMotionKey(
    turnId: string | null,
    messageId: string,
  ): string {
    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedTurnId) {
      throw new Error("Pending motion payload requires a non-empty turnId.");
    }
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    if (!normalizedMessageId) {
      throw new Error("Pending motion payload requires a non-empty messageId.");
    }
    return `${normalizedTurnId.length}:${normalizedTurnId}:${normalizedMessageId}`;
  }

  function syncPendingState(): void {
    hooks.onPendingStateChanged(
      pendingInboundMotionPayloads.size,
      pendingInboundMotionPayloads.values().next().value?.messageId ?? "",
    );
  }

  function buildStartContext(
    entry: PendingInboundMotionPayload,
    startReason: string,
  ): StartPayloadContext {
    return {
      turnId: entry.turnId,
      playbackTurnId: entry.playbackTurnId,
      messageId: entry.messageId,
      assistantText: entry.assistantText,
      playbackOrigin: "conversation",
      startReason,
      queuedDelayMs: Math.max(0, Math.round(performance.now() - entry.receivedAtMs)),
      playbackClock: entry.playbackClock,
      playbackClockReader: entry.playbackClockReader,
    };
  }

  function dropPendingPayload(
    entry: PendingInboundMotionPayload,
    startReason: string,
  ): void {
    pendingInboundMotionPayloads.delete(buildPendingMotionKey(entry.turnId, entry.messageId));
    hooks.onStartFailed?.(buildStartContext(entry, startReason));
  }

  function clearAllPendingPayloads(): void {
    for (const entry of Array.from(pendingInboundMotionPayloads.values())) {
      dropPendingPayload(entry, "motion_engine_stopped");
    }
    syncPendingState();
  }

  function cancelPendingPayloadForSegment(
    turnId: string | null,
    messageId: string,
  ): boolean {
    const key = buildPendingMotionKey(turnId, messageId);
    const entry = pendingInboundMotionPayloads.get(key);
    if (!entry) {
      return false;
    }
    pendingInboundMotionPayloads.delete(key);
    syncPendingState();
    return true;
  }

  function failPendingPayloadForSegment(
    turnId: string | null,
    messageId: string,
    reason: string,
  ): boolean {
    const key = buildPendingMotionKey(turnId, messageId);
    const entry = pendingInboundMotionPayloads.get(key);
    if (!entry) {
      return false;
    }
    dropPendingPayload(entry, reason);
    syncPendingState();
    return true;
  }

  function tryStartPendingPayload(
    turnId: string | null,
    messageId: string,
    startReason: string,
    playbackClock: MotionPlaybackClockContext | null = null,
  ): boolean {
    const key = buildPendingMotionKey(turnId, messageId);
    const entry = pendingInboundMotionPayloads.get(key);
    if (!entry) {
      return false;
    }

    if (playbackClock && matchesPlaybackTimeline(entry, playbackClock)) {
      entry.playbackClock = playbackClock;
    }
    pendingInboundMotionPayloads.delete(key);
    syncPendingState();
    const context = buildStartContext(entry, startReason);
    const started = hooks.onStartPayload(entry.payload, context);
    if (!started) {
      hooks.onStartFailed?.(context);
    }
    return started;
  }

  function failPendingPayloadForTimeline(
    snapshot: MotionPlaybackClockContext,
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
  ): boolean {
    const normalizedTurnId = normalizeTurnId(context.turnId);
    const normalizedPlaybackTurnId =
      normalizeTurnId(context.playbackTurnId ?? null) ?? normalizedTurnId;
    if (!normalizedTurnId) {
      hooks.onStartFailed?.({
        messageId: context.messageId,
        turnId: null,
        assistantText: context.assistantText,
        playbackTurnId: normalizedPlaybackTurnId,
        playbackOrigin: "conversation",
        startReason: "motion_turn_id_missing",
        queuedDelayMs: 0,
        playbackClock: context.playbackClock ?? null,
        playbackClockReader: context.playbackClockReader ?? null,
      });
      return false;
    }

    const pendingKey = buildPendingMotionKey(normalizedTurnId, context.messageId);
    if (pendingInboundMotionPayloads.has(pendingKey)) {
      console.error("[ModelEngine] duplicate pending motion payload rejected; keeping first payload.", {
        turnId: normalizedTurnId,
        messageId: context.messageId,
      });
      return false;
    }

    const entry: PendingInboundMotionPayload = {
      payload,
      messageId: context.messageId,
      turnId: normalizedTurnId,
      assistantText: context.assistantText,
      playbackTurnId: normalizedPlaybackTurnId,
      receivedAtMs: context.receivedAtMs,
      playbackClock: context.playbackClock ?? null,
      playbackClockReader: context.playbackClockReader ?? null,
      timelineMode: context.timelineMode,
    };

    if (entry.playbackClock && !matchesPlaybackTimeline(entry, entry.playbackClock)) {
      hooks.onStartFailed?.({
        messageId: entry.messageId,
        turnId: entry.turnId,
        assistantText: entry.assistantText,
        playbackTurnId: entry.playbackTurnId,
        playbackOrigin: "conversation",
        startReason: "playback_timeline_identity_mismatch",
        queuedDelayMs: 0,
        playbackClock: entry.playbackClock,
        playbackClockReader: entry.playbackClockReader,
      });
      return false;
    }

    pendingInboundMotionPayloads.set(pendingKey, entry);
    syncPendingState();
    hooks.onPendingStatus("动作已排队，等待音频起播。");
    console.info("[ModelEngine] queued motion payload.", {
      kind: payload.kind,
      turnId: normalizedTurnId,
      messageId: context.messageId,
      pendingCount: pendingInboundMotionPayloads.size,
    });

    if (entry.playbackClock) {
      if (isTimelineUnavailable(entry.playbackClock)) {
        failPendingPayloadForTimeline(
          entry.playbackClock,
          "playback_timeline_audio_unavailable_before_motion_start",
        );
        return false;
      }
      if (canStartFromPlaybackTimeline(entry, entry.playbackClock)) {
        return tryStartPendingPayload(
          entry.turnId,
          entry.messageId,
          entry.playbackClock.source === "synthetic"
            ? "motion_only_timeline_ready"
            : "playback_timeline_ready",
          entry.playbackClock,
        );
      }
    }
    return true;
  }

  function handlePlaybackTimelineStarted(
    playbackClock: MotionPlaybackClockContext,
  ): boolean {
    const entry = pendingInboundMotionPayloads.get(
      buildPendingMotionKey(playbackClock.turnId, playbackClock.messageId),
    );
    if (!entry) {
      return false;
    }
    // This callback is emitted by the real audio "started" event. The shared
    // timeline can still be preparing until motion reports that it started,
    // so requiring the aggregate timeline to be playing creates a deadlock.
    if (
      playbackClock.source !== "audio"
      || playbackClock.phase === "terminal"
    ) {
      if (isTimelineUnavailable(playbackClock)) {
        return failPendingPayloadForTimeline(
          playbackClock,
          "playback_timeline_audio_unavailable_before_motion_start",
        );
      }
      return false;
    }
    const started = tryStartPendingPayload(
      playbackClock.turnId,
      playbackClock.messageId,
      "playback_timeline_started",
      playbackClock,
    );
    console.info("[ModelEngine] playback timeline start handled.", {
      turnId: playbackClock.turnId,
      messageId: playbackClock.messageId,
      timelineId: playbackClock.timelineId,
      started,
      pendingCount: pendingInboundMotionPayloads.size,
    });
    return started;
  }

  function getPendingPayloadForTimeline(
    playbackClock: MotionPlaybackClockContext,
  ): PendingMotionPreparation | null {
    const entry = pendingInboundMotionPayloads.get(
      buildPendingMotionKey(playbackClock.turnId, playbackClock.messageId),
    );
    if (!entry || !matchesPlaybackTimeline(entry, playbackClock)) {
      return null;
    }
    if (playbackClock.source === "audio_unavailable") {
      return null;
    }
    entry.playbackClock = playbackClock;
    return {
      payload: entry.payload,
      context: buildStartContext(entry, "playback_timeline_preparing"),
    };
  }

  return {
    queueInboundPayload,
    getPendingPayloadForTimeline,
    handlePlaybackTimelineStarted,
    failPendingPayloadForSegment,
    cancelPendingPayloadForSegment,
    clearAllPendingPayloads,
  };
}
