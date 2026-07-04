import assert from "node:assert/strict";
import { createAdapterAudioRuntime } from "../src/adapter-connection/runtime/audioRuntime.js";
import type { StartAudioPlaybackOptions } from "../src/adapter-connection/runtime/audioPlayback.js";

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

async function testAudioPlaybackCreatesAudioClockTimeline(): Promise<void> {
  const state = buildState();
  const startOptionsRef: { current: StartAudioPlaybackOptions | null } = { current: null };
  const runtime = createAdapterAudioRuntime({
    state,
    startAudio: async (_url, options) => {
      startOptionsRef.current = options;
      options.onDurationChanged(1250);
      options.onPlaybackStarted({
        startedAtMs: 100,
        durationMs: 1250,
      });
    },
    stopAudioRuntime: () => {},
    pushHistory: () => {},
    getSessionStore: () => undefined,
    getAudioPlaybackClock: () => ({
      getCurrentTimeMs: () => 320,
      getDurationMs: () => 1250,
      getPlaybackRate: () => 1,
      isPlaying: () => true,
    }),
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
}

async function testAudioTimelineCompletesOnAudioEnded(): Promise<void> {
  const state = buildState();
  const startOptionsRef: { current: StartAudioPlaybackOptions | null } = { current: null };
  const runtime = createAdapterAudioRuntime({
    state,
    startAudio: async (_url, options) => {
      startOptionsRef.current = options;
      options.onDurationChanged(900);
      options.onPlaybackStarted({
        startedAtMs: 50,
        durationMs: 900,
      });
    },
    stopAudioRuntime: () => {},
    pushHistory: () => {},
    getSessionStore: () => undefined,
    getAudioPlaybackClock: () => ({
      getCurrentTimeMs: () => 900,
      getDurationMs: () => 900,
      getPlaybackRate: () => 1,
      isPlaying: () => true,
    }),
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/audio.wav", "turn-2", "msg-2");
  assert.equal(runtime.releaseAudioForPlayback("msg-2", "turn-2"), true);
  await flushMicrotasks();
  assert.ok(runtime.getActiveAudioTimelineSnapshot());

  const options = startOptionsRef.current;
  assert.ok(options);
  options.onEnded();

  assert.equal(runtime.getActiveAudioTimelineSnapshot(), null);
}

async function testAudioTimelineInterruptsPreparedAudioOnStopAll(): Promise<void> {
  const state = buildState();
  const runtime = createAdapterAudioRuntime({
    state,
    startAudio: async () => new Promise<void>(() => {}),
    stopAudioRuntime: () => {},
    pushHistory: () => {},
    getSessionStore: () => undefined,
    getAudioPlaybackClock: () => null,
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
    startAudio: async (_url, options) => {
      options.onPlaybackStarted({
        startedAtMs: 100,
        durationMs: 1000,
      });
      return new Promise<void>(() => {});
    },
    stopAudioRuntime: () => {},
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
    getAudioPlaybackClock: () => null,
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

async function run(): Promise<void> {
  await testAudioPlaybackCreatesAudioClockTimeline();
  await testAudioTimelineCompletesOnAudioEnded();
  await testAudioTimelineInterruptsPreparedAudioOnStopAll();
  await testStartingNextAudioSettlesInterruptedPreviousSegment();
  console.log("adapterAudioRuntime tests passed");
}

await run();
