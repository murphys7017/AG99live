import type { NormalizedMotionPayload } from "../model-engine/contracts.js";
import type { ModelEnginePlanStartedEvent } from "../model-engine/runtime/contracts.js";
import type { PlaybackTimelineSnapshot } from "../playback-timeline/contracts.js";
import type {
  MotionTimelineTerminal,
  PlaybackTimelineMotionContext,
  PlaybackTimelineMotionSink,
} from "../playback-timeline/motionTypes.js";

export interface ModelEnginePlaybackTimelineMotionEngine {
  ingestNormalizedPayload(
    payload: NormalizedMotionPayload,
    context: PlaybackTimelineMotionContext,
  ): boolean | void;
  notifyCurrentTurnChanged(turnId: string | null): void;
  interruptPlaybackSegment(
    turnId: string | null,
    messageId: string,
    reason: string,
  ): void;
}

export interface MotionTimelineTerminalEvent {
  runId: string;
  status: string;
  reason?: string;
}

export interface MotionTimelineRunTracker {
  recordStarted(event: ModelEnginePlanStartedEvent): void;
  recordTerminal(event: MotionTimelineTerminalEvent): void;
  clear(): void;
}

function normalizeTurnId(turnId: string | null): string | null {
  const normalized = typeof turnId === "string" ? turnId.trim() : "";
  return normalized || null;
}

function matchesMotionContext(
  snapshot: PlaybackTimelineSnapshot,
  context: PlaybackTimelineMotionContext,
): boolean {
  return (
    snapshot.messageId === context.messageId
    && normalizeTurnId(snapshot.turnId) === normalizeTurnId(context.turnId)
  );
}

function hasMotionSink(snapshot: PlaybackTimelineSnapshot): boolean {
  return snapshot.sinks.some((sink) => sink.id === "motion");
}

function canAttachTimelineForMotionStart(
  snapshot: PlaybackTimelineSnapshot,
  context: PlaybackTimelineMotionContext,
): boolean {
  if (context.timelineMode === "motion_only") {
    return snapshot.clockSource === "synthetic";
  }
  return (
    snapshot.clockSource === "audio"
    && (snapshot.phase === "playing" || snapshot.phase === "paused")
  );
}

function attachPlaybackTimelineToMotionContext(
  context: PlaybackTimelineMotionContext,
  snapshot: PlaybackTimelineSnapshot | null,
): PlaybackTimelineMotionContext | null {
  if (!snapshot || !matchesMotionContext(snapshot, context) || !hasMotionSink(snapshot)) {
    return null;
  }

  if (canAttachTimelineForMotionStart(snapshot, context)) {
    return {
      ...context,
      playbackTimeline: snapshot,
    };
  }

  if (context.timelineMode === "motion_only") {
    return null;
  }

  return {
    ...context,
    // Keep lifecycle ownership while audio is preparing. The scheduler still
    // waits for a playing audio clock before starting the motion.
    playbackTimeline: snapshot,
  };
}

export function createModelEngineMotionTimelineSink(options: {
  motionEngine: ModelEnginePlaybackTimelineMotionEngine;
  getPlaybackTimelineSnapshotForSegment: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineSnapshot | null;
  markMotionTimelineTerminal: (
    turnId: string | null,
    messageId: string,
    terminal: MotionTimelineTerminal,
    reason: string,
  ) => void;
}): PlaybackTimelineMotionSink<NormalizedMotionPayload> {
  return {
    start(payload, context) {
      const playbackTimelineSnapshot = options.getPlaybackTimelineSnapshotForSegment(
        context.turnId,
        context.messageId,
      );
      const nextContext = attachPlaybackTimelineToMotionContext(
        context,
        playbackTimelineSnapshot,
      );
      if (!nextContext) {
        options.markMotionTimelineTerminal(
          context.turnId,
          context.messageId,
          "failed",
          context.timelineMode === "motion_only"
            ? "motion_only_timeline_unavailable"
            : "motion_timeline_unavailable",
        );
        return false;
      }
      const accepted = options.motionEngine.ingestNormalizedPayload(
        payload,
        nextContext,
      );
      if (accepted === false && nextContext.playbackTimeline) {
        options.markMotionTimelineTerminal(
          context.turnId,
          context.messageId,
          "failed",
          "motion_payload_rejected",
        );
      }
      return accepted;
    },
    notifyCurrentTurnChanged(turnId) {
      options.motionEngine.notifyCurrentTurnChanged(turnId);
    },
    interrupt(turnId, messageId, reason) {
      options.motionEngine.interruptPlaybackSegment(turnId, messageId, reason);
    },
  };
}

export function createMotionTimelineRunTracker(options: {
  markMotionTimelineStarted: (
    turnId: string | null,
    messageId: string,
  ) => void;
  markMotionTimelineTerminal: (
    turnId: string | null,
    messageId: string,
    terminal: MotionTimelineTerminal,
    reason: string,
  ) => void;
}): MotionTimelineRunTracker {
  const runs = new Map<string, {
    turnId: string | null;
    messageId: string;
  }>();

  return {
    recordStarted(event) {
      if (event.startReason === "preview") {
        return;
      }
      options.markMotionTimelineStarted(event.turnId, event.messageId);
      runs.set(event.runId, {
        turnId: event.turnId,
        messageId: event.messageId,
      });
    },
    recordTerminal(event) {
      const owner = runs.get(event.runId);
      if (!owner) {
        return;
      }
      runs.delete(event.runId);
      options.markMotionTimelineTerminal(
        owner.turnId,
        owner.messageId,
        event.status === "completed"
          ? "completed"
          : event.status === "stopped"
            ? "interrupted"
            : "failed",
        event.reason || event.status,
      );
    },
    clear() {
      runs.clear();
    },
  };
}
