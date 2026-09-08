import type { PlaybackTimelineAudioSink } from "../playback-timeline/audioSink.js";
import {
  createPlaybackTimelineAudioLipSyncSink,
  type PlaybackTimelineAudioLipSyncSink,
} from "../playback-timeline/audioLipSyncCoordinator.js";
import {
  createPlaybackTimelineAudioSegmentSink,
} from "../playback-timeline/audioSegmentPlaybackSink.js";
import {
  createPlaybackTimelineAudioSegmentRunner,
} from "../playback-timeline/audioSegmentTimelineRunner.js";
import type {
  PlaybackTimelineAudioControl,
  PlaybackTimelineAudioSegmentIdentity,
} from "../playback-timeline/audioPlaybackControl.js";
import {
  createPlaybackTimelineLipSyncRuntime,
  type PlaybackTimelineLipSyncRuntime,
  type PlaybackTimelineLipSyncRuntimeCallbacks,
} from "../playback-timeline/lipSyncSink.js";
import type {
  PlaybackTimelineRuntime,
} from "../playback-timeline/playbackTimelineRuntime.js";
import { createLive2DLipSyncTimelineSink } from "../live2d/lipSyncTimelineSink.js";
import type { NormalizedMotionPayload } from "../types/motion.js";

export interface ConversationPlaybackAudioPresentation {
  reportAudioPlaybackPreparing(): void;
  reportAudioPlaybackStarted(turnId: string | null, durationMs: number | null): void;
  reportAudioPlaybackEnded(): void;
  reportAudioPlaybackFailed(reason: string): void;
  reportPlaybackHistory(text: string): void;
}

export interface ConversationPlaybackAudioRuntime extends PlaybackTimelineAudioControl {
  releaseAudioForTimelinePlayback(
    audioUrl: string,
    messageId: string,
    turnId: string | null,
  ): boolean;
}

export function createConversationPlaybackAudioRuntime(options: {
  playbackTimelineRuntime: PlaybackTimelineRuntime<NormalizedMotionPayload>;
  audioSink: PlaybackTimelineAudioSink;
  presentation: ConversationPlaybackAudioPresentation;
  createLipSyncRuntime?: (
    callbacks: PlaybackTimelineLipSyncRuntimeCallbacks,
  ) => PlaybackTimelineLipSyncRuntime;
}): ConversationPlaybackAudioRuntime {
  const { playbackTimelineRuntime, presentation } = options;
  const live2dLipSyncSink = createLive2DLipSyncTimelineSink();
  let activeLipSyncRuntime: PlaybackTimelineLipSyncRuntime | null = null;

  function createLipSyncRuntime(
    callbacks: PlaybackTimelineLipSyncRuntimeCallbacks,
  ): PlaybackTimelineLipSyncRuntime {
    activeLipSyncRuntime?.stop();
    const runtime = options.createLipSyncRuntime
      ? options.createLipSyncRuntime(callbacks)
      : createPlaybackTimelineLipSyncRuntime(live2dLipSyncSink, callbacks);
    activeLipSyncRuntime = runtime;
    return runtime;
  }

  function createLipSyncSink(
    turnId: string | null,
    messageId: string,
  ): PlaybackTimelineAudioLipSyncSink {
    return createPlaybackTimelineAudioLipSyncSink({
      turnId,
      messageId,
      pushHistory: (_role, text) => presentation.reportPlaybackHistory(text),
      createLipSyncRuntime,
      markLipSyncTimelineStarted: playbackTimelineRuntime.markLipSyncTimelineStarted,
      markLipSyncTimelineTerminal: playbackTimelineRuntime.markLipSyncTimelineTerminal,
    });
  }

  const audioSegmentSink = createPlaybackTimelineAudioSegmentSink({
    audioSink: options.audioSink,
    startLipSyncTimelineSink: playbackTimelineRuntime.startLipSyncTimelineSink,
    createLipSyncSink,
  });
  const audioSegmentRunner = createPlaybackTimelineAudioSegmentRunner({
    runtime: playbackTimelineRuntime,
    audioSegmentSink,
  });

  async function startAudioSegmentPlayback(
    audioUrl: string,
    turnId: string | null,
    messageId: string,
  ): Promise<void> {
    presentation.reportAudioPlaybackPreparing();
    await audioSegmentRunner.start(audioUrl, turnId, messageId, {
      onPlaybackStarted: (event) => {
        presentation.reportAudioPlaybackStarted(turnId, event.durationMs);
      },
      onEnded: () => {
        presentation.reportAudioPlaybackEnded();
      },
      onError: (reason) => {
        presentation.reportAudioPlaybackFailed(reason);
      },
    });
  }

  function releaseAudioForTimelinePlayback(
    audioUrl: string,
    messageId: string,
    turnId: string | null,
  ): boolean {
    if (!audioUrl.trim()) {
      return false;
    }
    void startAudioSegmentPlayback(audioUrl, turnId, messageId);
    return true;
  }

  function stopAudioPlayback(
    turnId: string | null,
    messageId: string | null,
    reason: string,
  ): void {
    try {
      audioSegmentRunner.stop(turnId, messageId, reason);
    } finally {
      presentation.reportAudioPlaybackEnded();
    }
  }

  function findActiveAudioSegments(): PlaybackTimelineAudioSegmentIdentity[] {
    return playbackTimelineRuntime.findActiveAudioTimelineSegments();
  }

  function findOpenAudioSegments(): PlaybackTimelineAudioSegmentIdentity[] {
    return playbackTimelineRuntime.findOpenAudioTimelineSegments();
  }

  function findActiveAudioSegment(): PlaybackTimelineAudioSegmentIdentity | null {
    return findActiveAudioSegments()[0] ?? null;
  }

  function findOpenAudioSegment(): PlaybackTimelineAudioSegmentIdentity | null {
    return findOpenAudioSegments()[0] ?? null;
  }

  function findOpenExecutionSegment(): PlaybackTimelineAudioSegmentIdentity | null {
    return playbackTimelineRuntime.findOpenExecutionTimelineSegments()[0] ?? null;
  }

  function stopAudioAndSettleTurn(turnId: string | null, reason: string): void {
    const errors: unknown[] = [];
    let activeSegment: PlaybackTimelineAudioSegmentIdentity | null = null;
    try {
      activeSegment = findOpenAudioSegments().find((segment) => segment.turnId === turnId) ?? null;
    } catch (error) {
      console.error("[AudioSettlement] open audio lookup failed.", error);
      errors.push(error);
    }
    if (activeSegment) {
      try {
        stopAudioPlayback(activeSegment.turnId, activeSegment.messageId, reason);
      } catch (error) {
        console.error(`[AudioSettlement] audio stop (${activeSegment.messageId}) failed.`, error);
        errors.push(error);
      }
    }
    try {
      playbackTimelineRuntime.stopTimelinesForTurn(turnId, reason);
    } catch (error) {
      console.error("[AudioSettlement] turn timeline stop failed.", error);
      errors.push(error);
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  function stopAudioAndSettleAll(reason: string): void {
    const errors: unknown[] = [];
    let activeSegments: PlaybackTimelineAudioSegmentIdentity[] = [];
    try {
      activeSegments = findOpenAudioSegments();
    } catch (error) {
      console.error("[AudioSettlement] open audio enumeration failed.", error);
      errors.push(error);
    }
    for (const segment of activeSegments) {
      try {
        stopAudioPlayback(segment.turnId, segment.messageId, reason);
      } catch (error) {
        console.error(`[AudioSettlement] audio stop (${segment.messageId}) failed.`, error);
        errors.push(error);
      }
    }
    try {
      playbackTimelineRuntime.stopAllTimelines(reason);
    } catch (error) {
      console.error("[AudioSettlement] all timeline stop failed.", error);
      errors.push(error);
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  return {
    releaseAudioForTimelinePlayback,
    stopAudioAndSettleTurn,
    stopAudioAndSettleAll,
    findActiveAudioSegment,
    findOpenAudioSegment,
    findOpenExecutionSegment,
  };
}
