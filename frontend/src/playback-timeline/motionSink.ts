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
): PlaybackTimelineMotionContext {
  if (!snapshot || !matchesMotionContext(snapshot, context)) {
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
}): PlaybackTimelineMotionSink {
  return {
    start(payload, context) {
      return options.motionEngine.ingestNormalizedPayload(
        payload,
        attachAudioTimelineToMotionContext(
          context,
          options.getActiveAudioTimelineSnapshot?.(),
        ),
      );
    },
    notifyCurrentTurnChanged(turnId) {
      options.motionEngine.notifyCurrentTurnChanged(turnId);
    },
  };
}
