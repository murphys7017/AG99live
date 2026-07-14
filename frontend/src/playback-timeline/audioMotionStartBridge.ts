import type { PlaybackTimelineSnapshot } from "./contracts.js";

export interface AudioMotionTimelineBridgeDeps {
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

export interface AudioMotionTimelineBridge {
  handleAudioTimelineStarted(
    turnId: string | null,
    messageId: string,
  ): void;
}

export function createAudioMotionTimelineBridge(
  deps: AudioMotionTimelineBridgeDeps,
): AudioMotionTimelineBridge {
  function handleAudioTimelineStarted(
    turnId: string | null,
    messageId: string,
  ): void {
    const normalizedTurnId = typeof turnId === "string" ? turnId.trim() : "";
    const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
    if (!normalizedTurnId || !normalizedMessageId) {
      throw new Error("Audio motion start requires turnId and messageId.");
    }
    const playbackTimeline = deps.getPlaybackTimelineSnapshotForSegment(
      normalizedTurnId,
      normalizedMessageId,
    );
    if (!playbackTimeline) {
      deps.onMissingPlaybackTimeline?.(
        normalizedTurnId,
        normalizedMessageId,
      );
      return;
    }
    const motionSink = playbackTimeline.sinks.find((sink) => sink.id === "motion");
    if (!motionSink || motionSink.terminal !== "idle") {
      return;
    }
    deps.handlePlaybackTimelineStarted(
      normalizedTurnId,
      normalizedMessageId,
      playbackTimeline,
    );
  }

  return { handleAudioTimelineStarted };
}
