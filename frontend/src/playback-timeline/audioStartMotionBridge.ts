import type { PlaybackTimelineSnapshot } from "./contracts.js";

export const AUDIO_START_MOTION_DELAY_MS = 90;

export interface AudioStartMotionTimelineBridgeDeps {
  delayMs?: number;
  schedule: (delayMs: number, fn: () => void) => unknown;
  clearSchedule: (timer: unknown) => void;
  canStartMotionForAudioTimeline?: (
    turnId: string,
    messageId: string,
  ) => boolean;
  getPlaybackTimelineSnapshotForSegment: (
    turnId: string,
    messageId: string,
  ) => PlaybackTimelineSnapshot | null;
  onMissingPlaybackTimeline?: (
    turnId: string,
    messageId: string,
  ) => void;
  handlePlaybackTimelineStarted: (
    turnId: string,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot,
  ) => boolean | void;
}

export interface AudioStartMotionTimelineBridge {
  handleAudioTimelineStarted(
    turnId: string | null,
    messageId: string,
  ): void;
  clear(): void;
}

export function createAudioStartMotionTimelineBridge(
  deps: AudioStartMotionTimelineBridgeDeps,
): AudioStartMotionTimelineBridge {
  const delayMs = deps.delayMs ?? AUDIO_START_MOTION_DELAY_MS;
  const timers = new Set<unknown>();
  const cancelledTimers = new Set<unknown>();

  function handleAudioTimelineStarted(
    turnId: string | null,
    messageId: string,
  ): void {
    const normalizedTurnId = typeof turnId === "string" ? turnId.trim() : "";
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    if (!normalizedTurnId || !normalizedMessageId) {
      return;
    }

    let timer: unknown = null;
    timer = deps.schedule(delayMs, () => {
      timers.delete(timer);
      if (cancelledTimers.delete(timer)) {
        return;
      }
      if (
        deps.canStartMotionForAudioTimeline
        && !deps.canStartMotionForAudioTimeline(normalizedTurnId, normalizedMessageId)
      ) {
        return;
      }
      const latestPlaybackTimeline = deps.getPlaybackTimelineSnapshotForSegment(
        normalizedTurnId,
        normalizedMessageId,
      );
      if (!latestPlaybackTimeline) {
        deps.onMissingPlaybackTimeline?.(
          normalizedTurnId,
          normalizedMessageId,
        );
        return;
      }
      deps.handlePlaybackTimelineStarted(
        normalizedTurnId,
        normalizedMessageId,
        latestPlaybackTimeline,
      );
    });
    timers.add(timer);
  }

  function clear(): void {
    for (const timer of Array.from(timers)) {
      timers.delete(timer);
      cancelledTimers.add(timer);
      deps.clearSchedule(timer);
    }
  }

  return {
    handleAudioTimelineStarted,
    clear,
  };
}
