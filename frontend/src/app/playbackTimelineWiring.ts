import type { AdapterPlaybackTimelinePort } from "../adapter-connection/useAdapterConnection.js";
import type { PlaybackTimelineSnapshot } from "../playback-timeline/contracts.js";
import type { PlaybackTimelineMotionSink } from "../playback-timeline/motionTypes.js";
import {
  createModelEngineMotionTimelineSink,
  createMotionTimelineRunTracker,
  projectMotionPlaybackClock,
  type MotionTimelineRunTracker,
} from "../playback-integrations/modelEngineMotionSink.js";
import {
  createAudioStartMotionTimelineBridge,
  type AudioStartMotionTimelineBridge,
} from "../playback-timeline/audioStartMotionBridge.js";
import type { useTurnPlaybackSessionStore } from "../turn-playback/useTurnPlaybackSessionStore.js";
import { isTerminalPhase } from "../turn-playback/session.js";

type TurnPlaybackSessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

export interface PlaybackTimelineMotionEnginePort {
  ingestNormalizedPayload: PlaybackTimelineMotionSink["start"];
  notifyCurrentTurnChanged(turnId: string | null): void;
  interruptPlaybackSegment(turnId: string | null, messageId: string, reason: string): void;
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
  sessionStore: TurnPlaybackSessionStore;
  motionEngine: PlaybackTimelineMotionEnginePort;
  schedule: (delayMs: number, fn: () => void) => unknown;
  clearSchedule: (timer: unknown) => void;
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
    sessionStore,
    motionEngine,
    schedule,
    clearSchedule,
    onMissingPlaybackTimeline,
  } = options;

  const audioStartMotionBridge: AudioStartMotionTimelineBridge =
    createAudioStartMotionTimelineBridge({
      schedule,
      clearSchedule,
      canStartMotionForAudioTimeline: (turnId, messageId) => {
        const session = sessionStore.getSession(turnId);
        const segment = session?.segments.get(messageId);
        return Boolean(
          session
          && segment
          && !isTerminalPhase(session.phase)
          && segment.audio.started
          && segment.audio.terminal === "idle",
        );
      },
      getPlaybackTimelineSnapshotForSegment: playbackTimeline.getPlaybackTimelineSnapshotForSegment,
      onMissingPlaybackTimeline,
      handlePlaybackTimelineStarted: (turnId, messageId, playbackTimelineSnapshot) =>
        motionEngine.handlePlaybackTimelineStarted(projectMotionPlaybackClock({
          ...playbackTimelineSnapshot,
          turnId,
          messageId,
        })),
    });

  playbackTimeline.setAudioTimelineStartedHandler((turnId, messageId) => {
    audioStartMotionBridge.handleAudioTimelineStarted(turnId, messageId);
  });

  const motionTimelineSink = createModelEngineMotionTimelineSink({
    motionEngine,
    getPlaybackTimelineSnapshotForSegment: playbackTimeline.getPlaybackTimelineSnapshotForSegment,
    markMotionTimelineTerminal: playbackTimeline.markMotionTimelineTerminal,
  });

  return {
    motionTimelineSink,
    dispose() {
      audioStartMotionBridge.clear();
      playbackTimeline.setAudioTimelineStartedHandler(null);
    },
  };
}
