export interface PlaybackTimelineAudioSessionPort {
  markAudioStarted: (
    turnId: string | null,
    messageId: string,
    startedAtMs?: number | null,
    durationMs?: number | null,
  ) => void;
  markAudioDuration: (
    turnId: string | null,
    messageId: string,
    durationMs: number | null,
  ) => void;
  markAudioTerminal: (
    turnId: string | null,
    terminal: "completed" | "failed" | "absent",
    messageId: string,
    reason?: string,
  ) => void;
}

export interface PlaybackTimelineMotionSessionPort {
  markMotionStarted: (
    turnId: string | null,
    messageId: string,
  ) => void;
  markMotionCompleted: (
    turnId: string | null,
    messageId: string,
  ) => void;
  markMotionFailed: (
    turnId: string | null,
    messageId: string,
    reason?: string,
  ) => void;
}

export type PlaybackTimelineTerminal = "completed" | "failed" | "interrupted";

export interface PlaybackTimelineSessionProjection {
  claimAudioRejection(identityKey: string): boolean;
  claimMotionRejection(identityKey: string): boolean;
  markAudioDuration(
    turnId: string | null,
    messageId: string,
    durationMs: number | null,
  ): void;
  markAudioStarted(
    turnId: string | null,
    messageId: string,
    startedAtMs: number,
    durationMs: number | null,
  ): void;
  markAudioTerminal(
    turnId: string | null,
    messageId: string,
    terminal: PlaybackTimelineTerminal,
    reason: string,
  ): void;
  markMotionStarted(turnId: string | null, messageId: string): void;
  markMotionTerminal(
    turnId: string | null,
    messageId: string,
    terminal: PlaybackTimelineTerminal,
    reason: string,
  ): void;
}

const MAX_REJECTION_KEYS = 512;

export function createPlaybackTimelineSessionProjection(options: {
  audioSession?: PlaybackTimelineAudioSessionPort;
  motionSession?: PlaybackTimelineMotionSessionPort;
}): PlaybackTimelineSessionProjection {
  const rejectedAudioKeys = new Set<string>();
  const rejectedMotionKeys = new Set<string>();

  return {
    claimAudioRejection: (identityKey) =>
      rememberNewBoundedKey(rejectedAudioKeys, identityKey),
    claimMotionRejection: (identityKey) =>
      rememberNewBoundedKey(rejectedMotionKeys, identityKey),
    markAudioDuration(turnId, messageId, durationMs) {
      options.audioSession?.markAudioDuration(turnId, messageId, durationMs);
    },
    markAudioStarted(turnId, messageId, startedAtMs, durationMs) {
      options.audioSession?.markAudioStarted(
        turnId,
        messageId,
        startedAtMs,
        durationMs,
      );
    },
    markAudioTerminal(turnId, messageId, terminal, reason) {
      options.audioSession?.markAudioTerminal(
        turnId,
        terminal === "completed" ? "completed" : "failed",
        messageId,
        reason,
      );
    },
    markMotionStarted(turnId, messageId) {
      options.motionSession?.markMotionStarted(turnId, messageId);
    },
    markMotionTerminal(turnId, messageId, terminal, reason) {
      if (terminal === "completed") {
        options.motionSession?.markMotionCompleted(turnId, messageId);
        return;
      }
      options.motionSession?.markMotionFailed(turnId, messageId, reason);
    },
  };
}

function rememberNewBoundedKey(keys: Set<string>, key: string): boolean {
  if (keys.has(key)) {
    return false;
  }
  keys.add(key);
  if (keys.size > MAX_REJECTION_KEYS) {
    const oldestKey = keys.values().next().value;
    if (oldestKey !== undefined) {
      keys.delete(oldestKey);
    }
  }
  return true;
}
