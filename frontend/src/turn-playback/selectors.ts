import type { TurnPlaybackSession } from "./session.js";

/**
 * Whether the session's text can be released (pushed to display).
 *
 * Text must not already be released and must have non-empty content.
 */
export function canReleaseText(session: TurnPlaybackSession): boolean {
  if (session.text.released) {
    return false;
  }
  const content = session.text.content;
  return typeof content === "string" && content.trim().length > 0;
}

/**
 * Whether the session's audio can be released (playback started).
 *
 * Audio must have a url and must not already have reached a terminal state.
 */
export function canReleaseAudio(session: TurnPlaybackSession): boolean {
  return (
    typeof session.audio.url === "string"
    && session.audio.url.trim().length > 0
    && session.audio.terminal === "idle"
  );
}

/**
 * Whether the session's motion payload can be released (handed to engine).
 *
 * Motion must have a payload and must not already be started.
 */
export function canReleaseMotion(session: TurnPlaybackSession): boolean {
  return session.motion.payload !== null && !session.motion.released;
}

/**
 * Whether the orchestrator should keep a wider sync window open
 * for a late motion plan to join the current playback group.
 *
 * Returns true when a motion payload has been received but not yet
 * started or completed — the group should wait.
 */
export function shouldWaitForLateMotion(
  session: TurnPlaybackSession,
  _nowMs: number,
): boolean {
  if (session.motion.absent) {
    return false;
  }
  if (session.motion.released || session.motion.completed) {
    return false;
  }
  return session.motion.payload !== null;
}

/**
 * Whether all conditions are met to ack playback_finished to the backend.
 *
 * Requires:
 *   - text delivered
 *   - audio terminal (completed / failed / absent)
 *   - motion completed (or no motion payload at all)
 *   - backend turn_finished observed
 */
export function isReadyToAckPlaybackFinished(
  session: TurnPlaybackSession,
): boolean {
  if (!session.text.delivered) {
    return false;
  }
  const terminal = session.audio.terminal;
  if (terminal !== "completed" && terminal !== "failed" && terminal !== "absent") {
    return false;
  }
  if (!session.motion.absent && !session.motion.completed) {
    return false;
  }
  if (!session.backend.turnFinished) {
    return false;
  }
  return true;
}
