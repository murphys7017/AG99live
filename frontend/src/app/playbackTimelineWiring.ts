import type { AdapterPlaybackTimelinePort } from "../adapter-connection/useAdapterConnection";
import type { PlaybackTimelineMotionSink } from "../playback-timeline/motionSink";
import type { useTurnPlaybackSessionStore } from "../turn-playback/useTurnPlaybackSessionStore";

type TurnPlaybackSessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

export function configurePlaybackTimelineSegmentExecution(options: {
  playbackTimeline: AdapterPlaybackTimelinePort;
  sessionStore: TurnPlaybackSessionStore;
  motionTimelineSink: Pick<PlaybackTimelineMotionSink, "start">;
}): void {
  const { playbackTimeline, sessionStore, motionTimelineSink } = options;
  playbackTimeline.setSegmentExecutionPorts({
    session: {
      markTextReleased: sessionStore.markTextReleased,
      markAudioReleased: sessionStore.markAudioReleased,
      markMotionReleased: sessionStore.markMotionReleased,
      markMotionFailed: sessionStore.markMotionFailed,
      markPhase: sessionStore.markPhase,
    },
    textSink: {
      releaseAssistantTextForPlayback: playbackTimeline.releaseAssistantTextForPlayback,
    },
    audioSink: {
      releaseAudioForPlayback: playbackTimeline.releaseAudioForPlayback,
    },
    motionSink: {
      start: motionTimelineSink.start,
    },
  });
}
