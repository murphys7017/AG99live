import type { NormalizedMotionPayload } from "../model-engine/contracts.js";
import type { ModelEnginePlanStartedEvent } from "../model-engine/runtime/contracts.js";
import type { PlaybackTimelineSnapshot } from "./contracts.js";

export interface PlaybackTimelineMotionContext {
  messageId: string;
  turnId: string | null;
  receivedAtMs: number;
  playbackTimeline?: PlaybackTimelineSnapshot | null;
  timelineMode?: "audio" | "motion_only";
}

export interface PlaybackTimelineMotionEngine {
  ingestNormalizedPayload(
    payload: NormalizedMotionPayload,
    context: PlaybackTimelineMotionContext,
  ): boolean | void;
  notifyCurrentTurnChanged(turnId: string | null): void;
}

export interface PlaybackTimelineMotionSink {
  start(
    payload: NormalizedMotionPayload,
    context: PlaybackTimelineMotionContext,
  ): boolean | void;
  notifyCurrentTurnChanged(turnId: string | null): void;
}

export type MotionTimelineTerminal = "completed" | "failed" | "interrupted";

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

function attachPlaybackTimelineToMotionContext(
  context: PlaybackTimelineMotionContext,
  snapshot: PlaybackTimelineSnapshot | null,
  prepareMotionTimeline: (
    turnId: string | null,
    messageId: string,
  ) => boolean,
  prepareMotionOnlyTimeline: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineSnapshot | null,
  getActiveTimelineSnapshot: () => PlaybackTimelineSnapshot | null,
): PlaybackTimelineMotionContext {
  if (snapshot && matchesMotionContext(snapshot, context)) {
    if (!prepareMotionTimeline(context.turnId, context.messageId)) {
      return {
        ...context,
        playbackTimeline: null,
      };
    }
    return {
      ...context,
      playbackTimeline: getActiveTimelineSnapshot() ?? snapshot,
    };
  }

  if (context.timelineMode !== "motion_only") {
    return {
      ...context,
      playbackTimeline: null,
    };
  }

  const motionOnlyTimeline = prepareMotionOnlyTimeline(
    context.turnId,
    context.messageId,
  );
  if (!motionOnlyTimeline || !matchesMotionContext(motionOnlyTimeline, context)) {
    return {
      ...context,
      playbackTimeline: null,
    };
  }
  return {
    ...context,
    playbackTimeline: motionOnlyTimeline,
  };
}

export function createModelEngineMotionTimelineSink(options: {
  motionEngine: PlaybackTimelineMotionEngine;
  getPlaybackTimelineSnapshotForSegment: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineSnapshot | null;
  prepareMotionTimelineSink: (
    turnId: string | null,
    messageId: string,
  ) => boolean;
  prepareMotionOnlyTimeline: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineSnapshot | null;
  markMotionTimelineTerminal: (
    turnId: string | null,
    messageId: string,
    terminal: MotionTimelineTerminal,
    reason: string,
  ) => void;
}): PlaybackTimelineMotionSink {
  return {
    start(payload, context) {
      const getSegmentTimelineSnapshot = () =>
        options.getPlaybackTimelineSnapshotForSegment(
          context.turnId,
          context.messageId,
        );
      const playbackTimelineSnapshot = getSegmentTimelineSnapshot();
      const nextContext = attachPlaybackTimelineToMotionContext(
        context,
        playbackTimelineSnapshot,
        options.prepareMotionTimelineSink,
        options.prepareMotionOnlyTimeline,
        getSegmentTimelineSnapshot,
      );
      if (context.timelineMode === "motion_only" && !nextContext.playbackTimeline) {
        options.markMotionTimelineTerminal(
          context.turnId,
          context.messageId,
          "failed",
          "motion_only_timeline_unavailable",
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
      if (event.runId) {
        runs.set(event.runId, {
          turnId: event.turnId,
          messageId: event.messageId,
        });
      }
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
