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

/**
 * Whether the session's text can be released (pushed to display).
 *
 * Text must not already be released and must have non-empty content.
 */
export function canReleaseText(segment: TurnPlaybackSegment): boolean {
  if (segment.text.released) {
    return false;
  }
  const content = segment.text.content;
  return typeof content === "string" && content.trim().length > 0;
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
 * Whether the orchestrator should keep a wider sync window open
 * for a late motion plan to join the current playback group.
 *
 * Returns true when a motion payload has been received but not yet
 * started or completed — the group should wait.
 */
export function shouldWaitForLateMotion(
  segment: TurnPlaybackSegment,
  _nowMs: number,
): boolean {
  if (segment.motion.absent) {
    return false;
  }
  if (segment.motion.released || segment.motion.completed || segment.motion.failed) {
    return false;
  }
  return segment.motion.payload !== null;
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
