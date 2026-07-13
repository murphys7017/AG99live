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
  PlaybackTimelineSnapshot,
} from "../../playback-timeline/contracts.js";
import {
  createPlaybackTimelineRuntime,
} from "../../playback-timeline/playbackTimelineRuntime.js";
import {
  startAudioSegmentAndBridgeState,
  stopAudioSegmentAndBridgeState,
  stopAudioSegmentAndBridgeStateForSegment,
  type AudioPlaybackStateBridgeContext,
  type AudioPlaybackState,
  type AudioPlaybackTerminalState,
} from "./audioPlaybackStateBridge.js";
import type {
  PlaybackTimelineAudioSessionPort,
  PlaybackTimelineMotionSessionPort,
} from "../../playback-timeline/playbackTimelineRuntime.js";
import type {
  PlaybackTimelineSegmentExecutionPorts,
} from "../../playback-timeline/segmentJob.js";

export interface AdapterAudioTimelineControllerDeps<TMotionPayload = unknown> {
  state: AudioPlaybackState;
  audioSink: PlaybackTimelineAudioSink;
  pushHistory: (role: string, text: string) => void;
  getAudioSession: () => PlaybackTimelineAudioSessionPort | undefined;
  getMotionSession: () => PlaybackTimelineMotionSessionPort | undefined;
  segmentExecution: PlaybackTimelineSegmentExecutionPorts<TMotionPayload>;
  createLipSyncRuntime?: (
    callbacks: PlaybackTimelineLipSyncRuntimeCallbacks,
  ) => PlaybackTimelineLipSyncRuntime;
  onAudioTimelineStarted?: (
    turnId: string | null,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot | null,
  ) => void;
  markTerminal: (
    terminalState: Exclude<AudioPlaybackTerminalState, "idle">,
    turnId: string | null,
    reason?: string,
    messageId?: string | null,
  ) => void;
  resetTerminal: () => void;
}

export function createAdapterAudioTimelineController<TMotionPayload = unknown>(
  deps: AdapterAudioTimelineControllerDeps<TMotionPayload>,
) {
  const live2dLipSyncSink = createLive2DLipSyncTimelineSink();
  let activeLipSyncRuntime: PlaybackTimelineLipSyncRuntime | null = null;
  const playbackTimelineRuntime = createPlaybackTimelineRuntime<TMotionPayload>({
    getAudioClock: () => deps.audioSink.getClock(),
    segmentExecution: deps.segmentExecution,
    get audioSession() {
      return deps.getAudioSession();
    },
    get motionSession() {
      return deps.getMotionSession();
    },
    onAudioTimelineStarted: deps.onAudioTimelineStarted,
  });

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
    markTerminal: deps.markTerminal,
    resetTerminal: deps.resetTerminal,
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
    stopAudioPlayback: () => {
      stopAudioSegmentAndBridgeState(audioPlaybackStateBridgeCtx);
    },
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
