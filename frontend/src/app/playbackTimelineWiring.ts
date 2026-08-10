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
  projectMotionPlaybackClockReader,
  type MotionTimelineRunTracker,
} from "../playback-integrations/modelEngineMotionSink.js";

export type PlaybackTimelineWiringPort = PlaybackTimelineRuntime<NormalizedMotionPayload>;
export interface PlaybackTimelineMotionEnginePort {
  ingestNormalizedPayload: PlaybackTimelineMotionSink["start"];
  interruptPlaybackSegment(turnId: string | null, messageId: string, reason: string): void;
  preparePlaybackTimeline(
    playbackTimeline: ReturnType<typeof projectMotionPlaybackClock>,
    assistantText: string,
  ): MotionTimelinePreparationResult;
  handlePlaybackTimelineStarted(
    playbackTimeline: ReturnType<typeof projectMotionPlaybackClock>,
    playbackClockReader: ReturnType<typeof projectMotionPlaybackClockReader>,
    assistantText: string,
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
  onAudioTimelineStarted: (
    turnId: string | null,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot,
  ) => void;
  onAudioTimelineDurationReady: (
    turnId: string | null,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot,
  ) => void;
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
    onAudioTimelineStarted: options.onAudioTimelineStarted,
    onAudioTimelineDurationReady: options.onAudioTimelineDurationReady,
  });

  adapterPlayback.initializeAudioRuntime(runtime, options.audioSink);

  return runtime;
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
  getCanonicalAssistantText: (
    turnId: string | null,
    messageId: string,
  ) => string;
}): {
  motionTimelineSink: PlaybackTimelineMotionSink;
  handleAudioTimelineStarted: (
    turnId: string | null,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot,
  ) => void;
  handleAudioTimelineDurationReady: (
    turnId: string | null,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot,
  ) => void;
} {
  const {
    playbackTimeline,
    motionEngine,
    onMissingPlaybackTimeline,
    getCanonicalAssistantText,
  } = options;

  function handleAudioTimelineStarted(
    turnId: string | null,
    messageId: string,
    preparedTimeline: PlaybackTimelineSnapshot,
  ): void {
    const normalizedTurnId = turnId?.trim() ?? "";
    const normalizedMessageId = messageId.trim();
    if (!normalizedTurnId || !normalizedMessageId) {
      throw new Error("Audio-backed motion requires turnId and messageId.");
    }
    const currentTimeline = playbackTimeline.getTimelineSnapshotForSegment(
      normalizedTurnId,
      normalizedMessageId,
    );
    if (!currentTimeline || currentTimeline.timelineId !== preparedTimeline.timelineId) {
      onMissingPlaybackTimeline?.(normalizedTurnId, normalizedMessageId);
      return;
    }
    const motionSink = currentTimeline.sinks.find((sink) => sink.id === "motion");
    if (!motionSink || motionSink.terminal !== "idle") {
      return;
    }
    const timelineClockReader = playbackTimeline.getTimelineClockReaderForSegment(
      normalizedTurnId,
      normalizedMessageId,
    );
    if (!timelineClockReader) {
      throw new Error("Audio-backed motion requires its segment Timeline clock reader.");
    }
    motionEngine.handlePlaybackTimelineStarted(
      projectMotionPlaybackClock(currentTimeline),
      projectMotionPlaybackClockReader(timelineClockReader),
      getCanonicalAssistantText(normalizedTurnId, normalizedMessageId),
    );
  }

  function handleAudioTimelineDurationReady(
    turnId: string | null,
    messageId: string,
    preparedTimeline: PlaybackTimelineSnapshot,
  ): void {
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
      getCanonicalAssistantText(turnId, messageId),
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
  }

  const motionTimelineSink = createModelEngineMotionTimelineSink({
    motionEngine,
    getPlaybackTimelineSnapshotForSegment: playbackTimeline.getTimelineSnapshotForSegment,
    getPlaybackTimelineClockReaderForSegment:
      playbackTimeline.getTimelineClockReaderForSegment,
    markMotionTimelineTerminal: playbackTimeline.markMotionTimelineTerminal,
  });

  return {
    motionTimelineSink,
    handleAudioTimelineStarted,
    handleAudioTimelineDurationReady,
  };
}
