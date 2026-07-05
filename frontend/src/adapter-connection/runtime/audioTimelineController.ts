import type { PlaybackTimelineAudioSink } from "../../playback-timeline/audioSink.js";
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

  const stopLipSyncRuntime = (): void => {
    activeLipSyncRuntime?.stop();
    activeLipSyncRuntime = null;
  };

  const audioPlaybackCtx: AudioPlaybackContext = {
    get state() {
      return deps.state;
    },
    audioSink: deps.audioSink,
    createLipSyncRuntime,
    stopLipSyncRuntime,
    prepareAudioTimeline: playbackTimelineRuntime.prepareAudioTimeline,
    markAudioTimelineDuration: playbackTimelineRuntime.markAudioTimelineDuration,
    markAudioTimelineStarted: playbackTimelineRuntime.markAudioTimelineStarted,
    markLipSyncTimelineStarted: playbackTimelineRuntime.markLipSyncTimelineStarted,
    markLipSyncTimelineTerminal: playbackTimelineRuntime.markLipSyncTimelineTerminal,
    markAudioTimelineTerminal: playbackTimelineRuntime.markAudioTimelineTerminal,
    stopAudioTimelineForSegment: playbackTimelineRuntime.stopTimelineForSegment,
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
  };
}
