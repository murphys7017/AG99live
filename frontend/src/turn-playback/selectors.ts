import type { TurnPlaybackSegment, TurnPlaybackSession } from "./session.js";
import { isSegmentLocallySettled } from "./session.js";

export function getActivePlaybackSegment(
  session: TurnPlaybackSession,
): TurnPlaybackSegment | null {
  for (const segmentId of session.segmentOrder) {
    const segment = session.segments.get(segmentId);
    if (segment && !isSegmentLocallySettled(segment)) {
      return segment;
    }
  }
  return null;
}

export function getNextPlaybackReleaseSegment(
  session: TurnPlaybackSession,
): TurnPlaybackSegment | null {
  for (const segmentId of session.segmentOrder) {
    const segment = session.segments.get(segmentId);
    if (
      segment
      && !isSegmentLocallySettled(segment)
      && !isAudioBackedMotionTail(segment)
    ) {
      return segment;
    }
  }
  return null;
}

function isAudioBackedMotionTail(segment: TurnPlaybackSegment): boolean {
  return (
    segment.text.delivered
    && segment.audio.started
    && segment.audio.terminal === "completed"
    && segment.motion.released
    && segment.motion.started
    && !segment.motion.completed
    && !segment.motion.failed
  );
}

/**
 * Whether the session's audio can be released (playback started).
 *
 * Audio must have a url and must not already have reached a terminal state.
 */
export function canReleaseAudio(segment: TurnPlaybackSegment): boolean {
  return (
    typeof segment.audio.url === "string"
    && segment.audio.url.trim().length > 0
    && !segment.audio.released
    && segment.audio.terminal === "idle"
  );
}

/**
 * Whether the session's motion payload can be released (handed to engine).
 *
 * Motion must have a payload and must not already be started.
 */
export function canReleaseMotion(segment: TurnPlaybackSegment): boolean {
  return segment.motion.payload !== null && !segment.motion.released;
}

/**
 * Whether local playback has fully settled on the frontend side.
 *
 * Requires:
 *   - text delivered
 *   - audio terminal (completed / failed / absent)
 *   - motion completed, or motion explicitly marked absent
 *
 * This does not include backend `turn_finished`.
 * Backend turn completion is a separate protocol step.
 */
export function isPlaybackLocallySettled(
  session: TurnPlaybackSession,
): boolean {
  if (session.segmentOrder.length === 0) {
    return false;
  }
  return session.segmentOrder.every((segmentId) => {
    const segment = session.segments.get(segmentId);
    return Boolean(segment && isSegmentLocallySettled(segment));
  });
}
