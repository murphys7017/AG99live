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
  createBrowserLipSyncTimelineSink,
  createPlaybackTimelineLipSyncRuntime,
  type PlaybackTimelineLipSyncRuntime,
  type PlaybackTimelineLipSyncRuntimeCallbacks,
} from "../../playback-timeline/lipSyncSink.js";
import type {
  PlaybackTimelineSnapshot,
} from "../../playback-timeline/contracts.js";
import {
  createPlaybackTimelineRuntime,
} from "../../playback-timeline/playbackTimelineRuntime.js";
import {
  playAudioAndAcknowledge as playAudioAction,
  stopAudioPlayback as stopAudioAction,
  stopAudioPlaybackForSegment as stopAudioForSegmentAction,
  type AudioPlaybackContext,
  type AudioPlaybackSessionStore,
  type AudioPlaybackState,
} from "./audioPlaybackActions.js";
import type { AudioPlaybackTerminalState } from "./audioRuntime.js";

export interface AdapterAudioTimelineControllerDeps {
  state: AudioPlaybackState;
  audioSink: PlaybackTimelineAudioSink;
  pushHistory: (role: string, text: string) => void;
  getSessionStore: () => AudioPlaybackSessionStore | undefined;
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

export function createAdapterAudioTimelineController(
  deps: AdapterAudioTimelineControllerDeps,
) {
  const browserLipSyncSink = createBrowserLipSyncTimelineSink();
  let activeLipSyncRuntime: PlaybackTimelineLipSyncRuntime | null = null;
  const playbackTimelineRuntime = createPlaybackTimelineRuntime({
    getAudioClock: () => deps.audioSink.getClock(),
    onAudioTimelineStarted: deps.onAudioTimelineStarted,
  });

  const createLipSyncRuntime = (
    callbacks: PlaybackTimelineLipSyncRuntimeCallbacks,
  ): PlaybackTimelineLipSyncRuntime => {
    activeLipSyncRuntime?.stop();
    const runtime = deps.createLipSyncRuntime
      ? deps.createLipSyncRuntime(callbacks)
      : createPlaybackTimelineLipSyncRuntime(browserLipSyncSink, callbacks);
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
    createLipSyncSink,
  });
  const audioSegmentRunner = createPlaybackTimelineAudioSegmentRunner({
    runtime: playbackTimelineRuntime,
    audioSegmentSink,
  });

  const audioPlaybackCtx: AudioPlaybackContext = {
    get state() {
      return deps.state;
    },
    audioSegmentRunner,
    pushHistory: deps.pushHistory,
    markTerminal: deps.markTerminal,
    resetTerminal: deps.resetTerminal,
    get sessionStore() {
      return deps.getSessionStore();
    },
  };

  return {
    playbackTimelineRuntime,
    playAudioAndAcknowledge: (
      audioUrl: string,
      turnId: string | null,
      messageId: string,
    ) => playAudioAction(audioPlaybackCtx, audioUrl, turnId, messageId),
    stopAudioPlayback: () => {
      stopAudioAction(audioPlaybackCtx);
    },
    stopAudioPlaybackForSegment: (
      turnId: string | null,
      messageId: string | null,
    ) => {
      stopAudioForSegmentAction(audioPlaybackCtx, turnId, messageId);
    },
  };
}
