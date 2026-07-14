import type { AdapterPlaybackTimelinePort } from "../adapter-connection/useAdapterConnection.js";
import type { MotionTimelinePreparationResult } from "../model-engine/runtime/playbackClock.js";
import type { PlaybackTimelineSnapshot } from "../playback-timeline/contracts.js";
import type { PlaybackTimelineMotionSink } from "../playback-timeline/motionTypes.js";
import {
  createModelEngineMotionTimelineSink,
  createMotionTimelineRunTracker,
  projectMotionPlaybackClock,
  type MotionTimelineRunTracker,
} from "../playback-integrations/modelEngineMotionSink.js";
import {
  createAudioMotionTimelineBridge,
  type AudioMotionTimelineBridge,
} from "../playback-timeline/audioMotionStartBridge.js";
export interface PlaybackTimelineMotionEnginePort {
  ingestNormalizedPayload: PlaybackTimelineMotionSink["start"];
  notifyCurrentTurnChanged(turnId: string | null): void;
  interruptPlaybackSegment(turnId: string | null, messageId: string, reason: string): void;
  preparePlaybackTimeline(
    playbackTimeline: ReturnType<typeof projectMotionPlaybackClock>,
  ): MotionTimelinePreparationResult;
  handlePlaybackTimelineStarted(
    playbackTimeline: ReturnType<typeof projectMotionPlaybackClock>,
  ): boolean | void;
}

export function createPlaybackTimelineMotionRunTracker(
  playbackTimeline: AdapterPlaybackTimelinePort,
): MotionTimelineRunTracker {
  return createMotionTimelineRunTracker({
    markMotionTimelineStarted: playbackTimeline.markMotionTimelineStarted,
    markMotionTimelineTerminal: playbackTimeline.markMotionTimelineTerminal,
  });
}

export function configurePlaybackTimelineMotionRuntime(options: {
  playbackTimeline: AdapterPlaybackTimelinePort;
  motionEngine: PlaybackTimelineMotionEnginePort;
  onMissingPlaybackTimeline?: (
    turnId: string,
    messageId: string,
  ) => void;
}): {
  motionTimelineSink: PlaybackTimelineMotionSink;
  dispose: () => void;
} {
  const {
    playbackTimeline,
    motionEngine,
    onMissingPlaybackTimeline,
  } = options;

  const audioMotionBridge: AudioMotionTimelineBridge =
    createAudioMotionTimelineBridge({
      getPlaybackTimelineSnapshotForSegment: playbackTimeline.getPlaybackTimelineSnapshotForSegment,
      onMissingPlaybackTimeline,
      handlePlaybackTimelineStarted: (_turnId, _messageId, preparedTimeline) =>
        motionEngine.handlePlaybackTimelineStarted(
          projectMotionPlaybackClock(preparedTimeline),
        ),
    });

  playbackTimeline.setAudioTimelineStartedHandler((turnId, messageId) => {
    audioMotionBridge.handleAudioTimelineStarted(turnId, messageId);
  });
  playbackTimeline.setAudioTimelineDurationReadyHandler(
    (turnId, messageId, preparedTimeline) => {
      const result = motionEngine.preparePlaybackTimeline(
        projectMotionPlaybackClock(preparedTimeline),
      );
      if (result.status === "not_applicable") {
        return;
      }
      if (result.status === "failed") {
        const motionSink = preparedTimeline.sinks.find((sink) => sink.id === "motion");
        if (motionSink && (motionSink.terminal === "idle" || motionSink.terminal === "started")) {
          playbackTimeline.markMotionTimelineTerminal(
            turnId,
            messageId,
            "failed",
            result.reason,
          );
        } else {
          console.error("[ModelEngine] speech-only motion preparation failed.", {
            turnId,
            messageId,
            reason: result.reason,
          });
        }
        return;
      }
      const registered = playbackTimeline.ensureMotionTimelineSinkForSegment(
        turnId,
        messageId,
        (reason) => motionEngine.interruptPlaybackSegment(
          turnId,
          messageId,
          reason,
        ),
      );
      if (!registered) {
        throw new Error("Prepared motion could not register its timeline sink.");
      }
    },
  );

  const motionTimelineSink = createModelEngineMotionTimelineSink({
    motionEngine,
    getPlaybackTimelineSnapshotForSegment: playbackTimeline.getPlaybackTimelineSnapshotForSegment,
    markMotionTimelineTerminal: playbackTimeline.markMotionTimelineTerminal,
  });

  return {
    motionTimelineSink,
    dispose() {
      playbackTimeline.setAudioTimelineDurationReadyHandler(null);
      playbackTimeline.setAudioTimelineStartedHandler(null);
    },
  };
}
