import type { NormalizedMotionPayload } from "../playback-integrations/motionPayload.js";
import type { AdapterPlaybackCompositionPort } from "../adapter-connection/useAdapterConnection.js";
import type { MotionTimelinePreparationResult } from "../model-engine/runtime/playbackClock.js";
import type { PlaybackTimelineAudioSink } from "../playback-timeline/audioSink.js";
import type { PlaybackTimelineSnapshot } from "../playback-timeline/contracts.js";
import {
  createPlaybackTimelineRuntime,
  type PlaybackTimelineRuntime,
} from "../playback-timeline/playbackTimelineRuntime.js";
import type { PlaybackTimelineSegmentMotionSink } from "../playback-timeline/segmentJob.js";
import type { PlaybackTimelineMotionSink } from "../playback-timeline/motionTypes.js";
import type { useTurnPlaybackSessionStore } from "../turn-playback/useTurnPlaybackSessionStore.js";
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

export type PlaybackTimelineWiringPort = PlaybackTimelineRuntime<NormalizedMotionPayload> & {
  setAudioTimelineDurationReadyHandler: (
    handler: ((
      turnId: string | null,
      messageId: string,
      playbackTimeline: PlaybackTimelineSnapshot,
    ) => void) | null,
  ) => void;
  setAudioTimelineStartedHandler: (
    handler: ((
      turnId: string | null,
      messageId: string,
      playbackTimeline: PlaybackTimelineSnapshot | null,
    ) => void) | null,
  ) => void;
};
export interface PlaybackTimelineMotionEnginePort {
  ingestNormalizedPayload: PlaybackTimelineMotionSink["start"];
  interruptPlaybackSegment(turnId: string | null, messageId: string, reason: string): void;
  preparePlaybackTimeline(
    playbackTimeline: ReturnType<typeof projectMotionPlaybackClock>,
  ): MotionTimelinePreparationResult;
  handlePlaybackTimelineStarted(
    playbackTimeline: ReturnType<typeof projectMotionPlaybackClock>,
  ): boolean | void;
}

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

export function createAppPlaybackTimelineRuntime(options: {
  sessionStore: SessionStore;
  adapterPlayback: AdapterPlaybackCompositionPort;
  motionSink: Pick<
    PlaybackTimelineSegmentMotionSink<NormalizedMotionPayload>,
    "start" | "interrupt"
  >;
  audioSink: PlaybackTimelineAudioSink;
}): PlaybackTimelineWiringPort {
  const { sessionStore, adapterPlayback } = options;
  const runtime = createPlaybackTimelineRuntime<NormalizedMotionPayload>({
    segmentExecution: {
      session: {
        markSessionFailed: sessionStore.markSessionFailed,
        markTextReleased: sessionStore.markTextReleased,
        markAudioReleased: sessionStore.markAudioReleased,
        markMotionReleased: sessionStore.markMotionReleased,
        markPhase: sessionStore.markPhase,
      },
      textSink: {
        releaseAssistantTextForPlayback:
          adapterPlayback.releaseAssistantTextForPlayback,
        failAssistantTextForPlayback:
          adapterPlayback.failAssistantTextForPlayback,
      },
      audioSink: {
        releaseAudioForPlayback:
          adapterPlayback.releaseAudioForTimelinePlayback,
      },
      motionSink: options.motionSink,
    },
    audioSession: {
      markAudioStarted: sessionStore.markAudioStarted,
      markAudioDuration: sessionStore.markAudioDuration,
      markAudioTerminal: sessionStore.markAudioTerminal,
    },
    motionSession: {
      markMotionStarted: sessionStore.markMotionStarted,
      markMotionCompleted: sessionStore.markMotionCompleted,
      markMotionFailed: sessionStore.markMotionFailed,
    },
    onAudioTimelineStarted: adapterPlayback.notifyAudioTimelineStarted,
    onAudioTimelineDurationReady:
      adapterPlayback.notifyAudioTimelineDurationReady,
  });

  adapterPlayback.initializeAudioRuntime(runtime, options.audioSink);

  return {
    ...runtime,
    setAudioTimelineDurationReadyHandler:
      adapterPlayback.setAudioTimelineDurationReadyHandler,
    setAudioTimelineStartedHandler:
      adapterPlayback.setAudioTimelineStartedHandler,
  };
}

export function createPlaybackTimelineMotionRunTracker(
  playbackTimeline: PlaybackTimelineWiringPort,
): MotionTimelineRunTracker {
  return createMotionTimelineRunTracker({
    markMotionTimelineStarted: playbackTimeline.markMotionTimelineStarted,
    markMotionTimelineTerminal: playbackTimeline.markMotionTimelineTerminal,
  });
}

export function configurePlaybackTimelineMotionRuntime(options: {
  playbackTimeline: PlaybackTimelineWiringPort;
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
      getPlaybackTimelineSnapshotForSegment: playbackTimeline.getTimelineSnapshotForSegment,
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
      console.info("[ModelEngine] audio timeline duration ready for motion preparation.", {
        turnId,
        messageId,
        timelineId: preparedTimeline.timelineId,
        phase: preparedTimeline.phase,
        clockSource: preparedTimeline.clockSource,
        durationMs: preparedTimeline.durationMs,
        sinks: preparedTimeline.sinks,
      });
      const result = motionEngine.preparePlaybackTimeline(
        projectMotionPlaybackClock(preparedTimeline),
      );
      if (result.status === "not_applicable") {
        return;
      }
      if (result.status === "failed") {
        console.error("[ModelEngine] motion preparation failed.", {
          turnId,
          messageId,
          source: result.source ?? "unknown",
          reason: result.reason,
        });
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
    getPlaybackTimelineSnapshotForSegment: playbackTimeline.getTimelineSnapshotForSegment,
    getPlaybackTimelineClockReaderForSegment:
      playbackTimeline.getTimelineClockReaderForSegment,
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
