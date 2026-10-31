import type { TurnPlaybackSegment, TurnPlaybackSession } from "./session.js";
import { isSegmentLocallySettled } from "./session.js";
import type { DeepReadonly } from "vue";

export function getActivePlaybackSegment(
  session: DeepReadonly<TurnPlaybackSession>,
): DeepReadonly<TurnPlaybackSegment> | null {
  for (const segmentId of session.segmentOrder) {
    const segment = session.segments.get(segmentId);
    if (segment && !isSegmentLocallySettled(segment)) {
      return segment;
    }
  }
  return null;
}

/**
 * Whether the session's audio can be released (playback started).
 *
 * Audio must have a url and must not already have reached a terminal state.
 */
export function canReleaseAudio(
  segment: DeepReadonly<TurnPlaybackSegment>,
): boolean {
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
export function canReleaseMotion(
  segment: DeepReadonly<TurnPlaybackSegment>,
): boolean {
  return segment.motion.payload !== null && !segment.motion.released;
}

/**
 * Whether all material for an atomic output segment has arrived and can be
 * handed to the playback timeline. This intentionally excludes local
 * delivery/terminal state; Timeline owns the actual release decision.
 */
export function isPlaybackSegmentResolved(
  segment: DeepReadonly<TurnPlaybackSegment>,
): boolean {
  const textResolved = Boolean(segment.text.content) || segment.text.delivered;
  const audioResolved = Boolean(segment.audio.url) || segment.audio.terminal !== "idle";
  const motionResolved = Boolean(segment.motion.payload)
    || segment.motion.pending
    || segment.motion.absent
    || segment.motion.failed;
  return textResolved && audioResolved && motionResolved;
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
  session: DeepReadonly<TurnPlaybackSession>,
): boolean {
  if (session.segmentOrder.length === 0) {
    return false;
  }
  return session.segmentOrder.every((segmentId) => {
    const segment = session.segments.get(segmentId);
    return Boolean(segment && isSegmentLocallySettled(segment));
  });
}
