import {
  getActiveAudioPlaybackClock,
  startAudioPlayback,
  stopAudioPlaybackRuntime,
  type RuntimeAudioPlaybackClock,
} from "../adapter-connection/runtime/audioPlayback.js";
import type { AudioPlaybackClock } from "./contracts.js";
import {
  createPlaybackTimelineLipSyncRuntime,
  createBrowserLipSyncTimelineSink,
  type PlaybackTimelineLipSyncSink,
} from "./lipSyncSink.js";

export interface PlaybackTimelineAudioLipSyncCallbacks {
  onUnavailable?: () => void;
  onStarted?: () => void;
  onTerminal?: (
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ) => void;
}

export interface PlaybackTimelineAudioElementContext {
  audioUrl: string;
  audio: HTMLAudioElement;
  getAudioCurrentTimeSeconds: () => number;
  isCurrentAudio: () => boolean;
}

export interface PlaybackTimelineAudioStartCallbacks {
  lipSync?: PlaybackTimelineAudioLipSyncCallbacks;
  onAudioElementCreated?: (event: PlaybackTimelineAudioElementContext) => void;
  onAudioElementDisposed?: () => void;
  onDurationChanged?: (durationMs: number | null) => void;
  onPlaybackStarted?: (event: { startedAtMs: number; durationMs: number | null }) => void;
  onEnded?: () => void;
  onError?: () => void;
}

export interface PlaybackTimelineAudioSink {
  start(audioUrl: string, callbacks?: PlaybackTimelineAudioStartCallbacks): Promise<void>;
  stop(): void;
  getClock(): AudioPlaybackClock | null;
}

function adaptClock(clock: RuntimeAudioPlaybackClock): AudioPlaybackClock {
  return {
    getCurrentTimeMs: () => clock.getCurrentTimeMs(),
    getDurationMs: () => clock.getDurationMs(),
    getPlaybackRate: () => clock.getPlaybackRate(),
    isPlaying: () => clock.isPlaying(),
  };
}

export function createBrowserAudioTimelineSink(): PlaybackTimelineAudioSink {
  return {
    async start(audioUrl, callbacks = {}) {
      await startAudioPlayback(audioUrl, {
        onAudioElementCreated: (event) => {
          callbacks.onAudioElementCreated?.({
            audioUrl,
            audio: event.audio,
            getAudioCurrentTimeSeconds: event.getAudioCurrentTimeSeconds,
            isCurrentAudio: event.isCurrentAudio,
          });
        },
        onAudioElementDisposed: () => {
          callbacks.onAudioElementDisposed?.();
        },
        onDurationChanged: (durationMs) => callbacks.onDurationChanged?.(durationMs),
        onPlaybackStarted: (event) => {
          callbacks.onPlaybackStarted?.(event);
        },
        onEnded: () => {
          callbacks.onEnded?.();
        },
        onError: () => {
          callbacks.onError?.();
        },
      });
    },
    stop() {
      stopAudioPlaybackRuntime();
    },
    getClock() {
      const clock = getActiveAudioPlaybackClock();
      return clock ? adaptClock(clock) : null;
    },
  };
}

export function createAudioTimelineSinkWithLipSync(
  audioSink: PlaybackTimelineAudioSink,
  lipSyncSink: PlaybackTimelineLipSyncSink = createBrowserLipSyncTimelineSink(),
): PlaybackTimelineAudioSink {
  return {
    async start(audioUrl, callbacks = {}) {
      const lipSyncRuntime = createPlaybackTimelineLipSyncRuntime(
        lipSyncSink,
        {
          onUnavailable: callbacks.lipSync?.onUnavailable,
          onStarted: callbacks.lipSync?.onStarted,
          onTerminal: callbacks.lipSync?.onTerminal,
        },
      );
      await audioSink.start(audioUrl, {
        ...callbacks,
        onAudioElementCreated: (event) => {
          lipSyncRuntime.attachAudio({
            audioUrl: event.audioUrl,
            audio: event.audio,
            getAudioCurrentTimeSeconds: event.getAudioCurrentTimeSeconds,
            isCurrentAudio: event.isCurrentAudio,
          });
          callbacks.onAudioElementCreated?.(event);
        },
        onAudioElementDisposed: () => {
          lipSyncRuntime.stop();
          callbacks.onAudioElementDisposed?.();
        },
        onPlaybackStarted: (event) => {
          void lipSyncRuntime.resume();
          callbacks.onPlaybackStarted?.(event);
        },
        onEnded: () => {
          lipSyncRuntime.completeAfterAudioEnded();
          callbacks.onEnded?.();
        },
        onError: () => {
          lipSyncRuntime.failAfterAudioError();
          callbacks.onError?.();
        },
      });
    },
    stop() {
      lipSyncSink.stop();
      audioSink.stop();
    },
    getClock() {
      return audioSink.getClock();
    },
  };
}

export function createBrowserAudioTimelineSinkWithLipSync(
  lipSyncSink?: PlaybackTimelineLipSyncSink,
): PlaybackTimelineAudioSink {
  return createAudioTimelineSinkWithLipSync(
    createBrowserAudioTimelineSink(),
    lipSyncSink,
  );
}
