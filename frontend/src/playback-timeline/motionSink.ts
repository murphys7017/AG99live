import type { NormalizedMotionPayload } from "../model-engine/contracts.js";
import type { PlaybackTimelineSnapshot } from "./contracts.js";

export interface PlaybackTimelineMotionContext {
  messageId: string;
  turnId: string | null;
  receivedAtMs: number;
  playbackTimeline?: PlaybackTimelineSnapshot | null;
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

function attachAudioTimelineToMotionContext(
  context: PlaybackTimelineMotionContext,
  snapshot: PlaybackTimelineSnapshot | null | undefined,
  prepareMotionTimeline?: (
    turnId: string | null,
    messageId: string,
  ) => boolean,
): PlaybackTimelineMotionContext {
  if (!snapshot || !matchesMotionContext(snapshot, context)) {
    return {
      ...context,
      playbackTimeline: null,
    };
  }
  if (prepareMotionTimeline && !prepareMotionTimeline(context.turnId, context.messageId)) {
    return {
      ...context,
      playbackTimeline: null,
    };
  }
  return {
    ...context,
    playbackTimeline: snapshot,
  };
}

export function createModelEngineMotionTimelineSink(options: {
  motionEngine: PlaybackTimelineMotionEngine;
  getActiveAudioTimelineSnapshot?: () => PlaybackTimelineSnapshot | null;
  prepareMotionTimelineSink?: (
    turnId: string | null,
    messageId: string,
  ) => boolean;
  markMotionTimelineTerminal?: (
    turnId: string | null,
    messageId: string,
    terminal: MotionTimelineTerminal,
    reason: string,
  ) => void;
}): PlaybackTimelineMotionSink {
  return {
    start(payload, context) {
      const nextContext = attachAudioTimelineToMotionContext(
        context,
        options.getActiveAudioTimelineSnapshot?.(),
        options.prepareMotionTimelineSink,
      );
      const accepted = options.motionEngine.ingestNormalizedPayload(
        payload,
        nextContext,
      );
      if (accepted === false && nextContext.playbackTimeline) {
        options.markMotionTimelineTerminal?.(
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
