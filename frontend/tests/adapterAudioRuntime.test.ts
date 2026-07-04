import assert from "node:assert/strict";
import { createAdapterAudioRuntime } from "../src/adapter-connection/runtime/audioRuntime.js";
import type {
  PlaybackTimelineAudioSink,
  PlaybackTimelineAudioStartCallbacks,
} from "../src/playback-timeline/audioSink.js";
import type { AudioPlaybackClock } from "../src/playback-timeline/contracts.js";

function buildState() {
  return {
    isPlayingAudio: false,
    currentTurnId: null as string | null,
    statusMessage: "",
    lastError: "",
    pendingAudios: new Map(),
    audioPlaybackStartedTurnId: null as string | null,
    audioPlaybackStartedMessageId: null as string | null,
    audioPlaybackStartedAtMs: 0,
    audioPlaybackDurationMs: null as number | null,
    audioPlaybackTerminalState: "idle" as const,
    audioPlaybackTerminalTurnId: null as string | null,
    audioPlaybackTerminalReason: "",
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function buildAudioSink(options: {
  start: (url: string, callbacks: PlaybackTimelineAudioStartCallbacks) => Promise<void>;
  stop?: () => void;
  getClock?: () => AudioPlaybackClock | null;
}): PlaybackTimelineAudioSink {
  return {
    start: options.start,
    stop: options.stop ?? (() => {}),
    getClock: options.getClock ?? (() => null),
  };
}

async function testAudioPlaybackCreatesAudioClockTimeline(): Promise<void> {
  const state = buildState();
  const startOptionsRef: { current: PlaybackTimelineAudioStartCallbacks | null } = { current: null };
  const audioTimelineStarted: Array<{
    turnId: string | null;
    messageId: string;
    phase: string | undefined;
    durationMs: number | null | undefined;
  }> = [];
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async (_url, callbacks) => {
        startOptionsRef.current = callbacks;
        callbacks.onDurationChanged?.(1250);
        callbacks.onPlaybackStarted?.({
          startedAtMs: 100,
          durationMs: 1250,
        });
        callbacks.lipSync?.onStarted?.();
      },
      getClock: () => ({
        getCurrentTimeMs: () => 320,
        getDurationMs: () => 1250,
        getPlaybackRate: () => 1,
        isPlaying: () => true,
      }),
    }),
    pushHistory: () => {},
    getSessionStore: () => undefined,
    onAudioTimelineStarted: (turnId, messageId, playbackTimeline) => {
      audioTimelineStarted.push({
        turnId,
        messageId,
        phase: playbackTimeline?.phase,
        durationMs: playbackTimeline?.durationMs,
      });
    },
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/audio.wav", "turn-1", "msg-1");
  assert.equal(runtime.releaseAudioForPlayback("msg-1", "turn-1"), true);
  await flushMicrotasks();

  assert.ok(startOptionsRef.current);
  const snapshot = runtime.getActiveAudioTimelineSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot?.phase, "playing");
  assert.equal(snapshot?.clockSource, "audio");
  assert.equal(snapshot?.currentTimeMs, 320);
  assert.equal(snapshot?.durationMs, 1250);
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "audio")?.terminal, "started");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "lip_sync")?.terminal, "started");
  assert.deepEqual(audioTimelineStarted, [
    {
      turnId: "turn-1",
      messageId: "msg-1",
      phase: "playing",
      durationMs: 1250,
    },
  ]);
}

async function testAudioTimelineCompletesOnAudioEnded(): Promise<void> {
  const state = buildState();
  const startOptionsRef: { current: PlaybackTimelineAudioStartCallbacks | null } = { current: null };
  const audioTimelineStarted: Array<{
    turnId: string | null;
    messageId: string;
    phase: string | undefined;
    durationMs: number | null | undefined;
  }> = [];
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async (_url, callbacks) => {
        startOptionsRef.current = callbacks;
        callbacks.onDurationChanged?.(900);
        callbacks.onPlaybackStarted?.({
          startedAtMs: 50,
          durationMs: 900,
        });
        callbacks.lipSync?.onStarted?.();
      },
      getClock: () => ({
        getCurrentTimeMs: () => 900,
        getDurationMs: () => 900,
        getPlaybackRate: () => 1,
        isPlaying: () => true,
      }),
    }),
    pushHistory: () => {},
    getSessionStore: () => undefined,
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/audio.wav", "turn-2", "msg-2");
  assert.equal(runtime.releaseAudioForPlayback("msg-2", "turn-2"), true);
  await flushMicrotasks();
  assert.ok(runtime.getActiveAudioTimelineSnapshot());

  const options = startOptionsRef.current;
  assert.ok(options);
  options.lipSync?.onTerminal?.("completed", "audio_playback_completed");
  options.onEnded?.();

  assert.equal(runtime.getActiveAudioTimelineSnapshot(), null);
}

async function testLipSyncFailureRemainsVisibleUntilAudioCompletes(): Promise<void> {
  const state = buildState();
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async (_url, callbacks) => {
        callbacks.onPlaybackStarted?.({
          startedAtMs: 80,
          durationMs: 1000,
        });
        callbacks.lipSync?.onTerminal?.("failed", "lip_sync_unavailable");
        callbacks.lipSync?.onTerminal?.("completed", "audio_playback_completed");
      },
      getClock: () => ({
        getCurrentTimeMs: () => 100,
        getDurationMs: () => 1000,
        getPlaybackRate: () => 1,
        isPlaying: () => true,
      }),
    }),
    pushHistory: () => {},
    getSessionStore: () => undefined,
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/audio.wav", "turn-lip", "msg-lip");
  assert.equal(runtime.releaseAudioForPlayback("msg-lip", "turn-lip"), true);
  await flushMicrotasks();

  const snapshot = runtime.getActiveAudioTimelineSnapshot();
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "lip_sync")?.terminal, "failed");
  assert.equal(
    snapshot?.sinks.find((sink) => sink.id === "lip_sync")?.reason,
    "lip_sync_unavailable",
  );
}

async function testAudioTimelineInterruptsPreparedAudioOnStopAll(): Promise<void> {
  const state = buildState();
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async () => new Promise<void>(() => {}),
    }),
    pushHistory: () => {},
    getSessionStore: () => undefined,
  });

  void runtime.playAudioAndAcknowledge(
    "http://127.0.0.1/audio.wav",
    "turn-3",
    "msg-3",
  );
  await flushMicrotasks();
  assert.equal(runtime.getActiveAudioTimelineSnapshot()?.phase, "preparing");

  runtime.stopAudioAndSettleAll("test_stop_all");

  assert.equal(runtime.getActiveAudioTimelineSnapshot(), null);
}

async function testStartingNextAudioSettlesInterruptedPreviousSegment(): Promise<void> {
  const state = buildState();
  const terminalEvents: Array<{
    turnId: string | null;
    terminal: string;
    messageId: string;
    reason?: string;
  }> = [];
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async (_url, callbacks) => {
        callbacks.onPlaybackStarted?.({
          startedAtMs: 100,
          durationMs: 1000,
        });
        return new Promise<void>(() => {});
      },
    }),
    pushHistory: () => {},
    getSessionStore: () => ({
      markAudioStarted: () => {},
      markAudioDuration: () => {},
      markAudioTerminal: (turnId, terminal, messageId, reason) => {
        terminalEvents.push({
          turnId,
          terminal,
          messageId,
          reason,
        });
      },
      getSessions: () => [],
    }),
  });

  void runtime.playAudioAndAcknowledge(
    "http://127.0.0.1/first.wav",
    "turn-4",
    "msg-4a",
  );
  await flushMicrotasks();
  assert.equal(state.audioPlaybackStartedMessageId, "msg-4a");

  void runtime.playAudioAndAcknowledge(
    "http://127.0.0.1/second.wav",
    "turn-4",
    "msg-4b",
  );
  await flushMicrotasks();

  assert.deepEqual(terminalEvents[0], {
    turnId: "turn-4",
    terminal: "failed",
    messageId: "msg-4a",
    reason: "audio_playback_stopped",
  });
}

async function testMotionSinkKeepsTimelineOpenAfterAudioCompletes(): Promise<void> {
  const state = buildState();
  const startOptionsRef: { current: PlaybackTimelineAudioStartCallbacks | null } = { current: null };
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async (_url, callbacks) => {
        startOptionsRef.current = callbacks;
        callbacks.onDurationChanged?.(900);
        callbacks.onPlaybackStarted?.({
          startedAtMs: 50,
          durationMs: 900,
        });
      },
      getClock: () => ({
        getCurrentTimeMs: () => 500,
        getDurationMs: () => 900,
        getPlaybackRate: () => 1,
        isPlaying: () => true,
      }),
    }),
    pushHistory: () => {},
    getSessionStore: () => undefined,
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/audio.wav", "turn-motion", "msg-motion");
  assert.equal(runtime.releaseAudioForPlayback("msg-motion", "turn-motion"), true);
  await flushMicrotasks();

  assert.equal(runtime.prepareMotionTimelineSink("turn-motion", "msg-motion"), true);
  runtime.markMotionTimelineStarted("turn-motion", "msg-motion");
  startOptionsRef.current?.onEnded?.();

  let snapshot = runtime.getActiveAudioTimelineSnapshot();
  assert.equal(snapshot?.phase, "playing");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "audio")?.terminal, "completed");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal, "started");

  runtime.markMotionTimelineTerminal(
    "turn-motion",
    "msg-motion",
    "completed",
    "motion_completed_after_audio",
  );

  snapshot = runtime.getActiveAudioTimelineSnapshot();
  assert.equal(snapshot, null);
}

async function testMotionOnlyTimelineUsesSyntheticClock(): Promise<void> {
  const state = buildState();
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async () => {},
    }),
    pushHistory: () => {},
    getSessionStore: () => undefined,
  });

  let snapshot = runtime.prepareMotionOnlyTimeline("turn-motion-only", "msg-motion-only");
  assert.equal(snapshot?.phase, "preparing");
  assert.equal(snapshot?.clockSource, "synthetic");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "motion")?.required, true);
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal, "idle");

  runtime.markMotionTimelineStarted("turn-motion-only", "msg-motion-only");
  snapshot = runtime.getActiveAudioTimelineSnapshot();
  assert.equal(snapshot?.phase, "playing");
  assert.equal(snapshot?.clockSource, "synthetic");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal, "started");

  runtime.markMotionTimelineTerminal(
    "turn-motion-only",
    "msg-motion-only",
    "completed",
    "motion_only_completed",
  );
  assert.equal(runtime.getActiveAudioTimelineSnapshot(), null);
}

async function run(): Promise<void> {
  await testAudioPlaybackCreatesAudioClockTimeline();
  await testAudioTimelineCompletesOnAudioEnded();
  await testLipSyncFailureRemainsVisibleUntilAudioCompletes();
  await testAudioTimelineInterruptsPreparedAudioOnStopAll();
  await testStartingNextAudioSettlesInterruptedPreviousSegment();
  await testMotionSinkKeepsTimelineOpenAfterAudioCompletes();
  await testMotionOnlyTimelineUsesSyntheticClock();
  console.log("adapterAudioRuntime tests passed");
}

await run();
