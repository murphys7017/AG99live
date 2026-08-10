import type { PlaybackTimelineAudioSink } from "../../playback-timeline/audioSink.js";
import {
  createPlaybackTimelineAudioLipSyncSink,
  type PlaybackTimelineAudioLipSyncSink,
} from "../../playback-timeline/audioLipSyncCoordinator.js";
import {
  createPlaybackTimelineAudioSegmentSink,
} from "../../playback-timeline/audioSegmentPlaybackSink.js";
import {
  createPlaybackTimelineAudioSegmentRunner,
} from "../../playback-timeline/audioSegmentTimelineRunner.js";
import {
  createPlaybackTimelineLipSyncRuntime,
  type PlaybackTimelineLipSyncRuntime,
  type PlaybackTimelineLipSyncRuntimeCallbacks,
} from "../../playback-timeline/lipSyncSink.js";
import {
  createLive2DLipSyncTimelineSink,
} from "../../live2d/lipSyncTimelineSink.js";
import type {
  PlaybackTimelineRuntime,
} from "../../playback-timeline/playbackTimelineRuntime.js";
import {
  startAudioSegmentAndBridgeState,
  stopAudioSegmentAndBridgeStateForSegment,
  type AudioPlaybackStateBridgeContext,
  type AudioPlaybackState,
} from "./audioPlaybackStateBridge.js";

export interface AdapterAudioTimelineControllerDeps<TMotionPayload = unknown> {
  state: AudioPlaybackState;
  audioSink: PlaybackTimelineAudioSink;
  playbackTimelineRuntime: PlaybackTimelineRuntime<TMotionPayload>;
  pushHistory: (role: string, text: string) => void;
  createLipSyncRuntime?: (
    callbacks: PlaybackTimelineLipSyncRuntimeCallbacks,
  ) => PlaybackTimelineLipSyncRuntime;
}

export function createAdapterAudioTimelineController<TMotionPayload = unknown>(
  deps: AdapterAudioTimelineControllerDeps<TMotionPayload>,
) {
  const live2dLipSyncSink = createLive2DLipSyncTimelineSink();
  let activeLipSyncRuntime: PlaybackTimelineLipSyncRuntime | null = null;
  const playbackTimelineRuntime = deps.playbackTimelineRuntime;

  const createLipSyncRuntime = (
    callbacks: PlaybackTimelineLipSyncRuntimeCallbacks,
  ): PlaybackTimelineLipSyncRuntime => {
    activeLipSyncRuntime?.stop();
    const runtime = deps.createLipSyncRuntime
      ? deps.createLipSyncRuntime(callbacks)
      : createPlaybackTimelineLipSyncRuntime(live2dLipSyncSink, callbacks);
    activeLipSyncRuntime = runtime;
    return runtime;
  };

  const createLipSyncSink = (
    turnId: string | null,
    messageId: string,
  ): PlaybackTimelineAudioLipSyncSink => {
    return createPlaybackTimelineAudioLipSyncSink({
      turnId,
      messageId,
      pushHistory: deps.pushHistory,
      createLipSyncRuntime,
      markLipSyncTimelineStarted: playbackTimelineRuntime.markLipSyncTimelineStarted,
      markLipSyncTimelineTerminal: playbackTimelineRuntime.markLipSyncTimelineTerminal,
    });
  };

  const audioSegmentSink = createPlaybackTimelineAudioSegmentSink({
    audioSink: deps.audioSink,
    startLipSyncTimelineSink: playbackTimelineRuntime.startLipSyncTimelineSink,
    createLipSyncSink,
  });
  const audioSegmentRunner = createPlaybackTimelineAudioSegmentRunner({
    runtime: playbackTimelineRuntime,
    audioSegmentSink,
  });

  const audioPlaybackStateBridgeCtx: AudioPlaybackStateBridgeContext = {
    get state() {
      return deps.state;
    },
    audioSegmentRunner,
    pushHistory: deps.pushHistory,
  };

  return {
    playbackTimelineRuntime,
    startAudioSegmentPlayback: (
      audioUrl: string,
      turnId: string | null,
      messageId: string,
    ) => startAudioSegmentAndBridgeState(
      audioPlaybackStateBridgeCtx,
      audioUrl,
      turnId,
      messageId,
    ),
    stopAudioPlaybackForSegment: (
      turnId: string | null,
      messageId: string | null,
      reason: string,
    ) => {
      stopAudioSegmentAndBridgeStateForSegment(
        audioPlaybackStateBridgeCtx,
        turnId,
        messageId,
        reason,
      );
    },
  };
}
