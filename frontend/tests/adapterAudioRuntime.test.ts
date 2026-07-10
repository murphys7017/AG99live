import assert from "node:assert/strict";
import { createAdapterAudioRuntime } from "../src/adapter-connection/runtime/audioRuntime.js";
import type {
  PlaybackTimelineAudioSink,
  PlaybackTimelineAudioStartCallbacks,
} from "../src/playback-timeline/audioSink.js";
import type { AudioPlaybackClock } from "../src/playback-timeline/contracts.js";
import type {
  PlaybackTimelineLipSyncRuntimeCallbacks,
} from "../src/playback-timeline/lipSyncSink.js";
import type { NormalizedMotionPayload } from "../src/model-engine/contracts.js";
import type { AdapterAudioRuntimeSessionStore } from "../src/adapter-connection/runtime/audioRuntime.js";

const motionPayload: NormalizedMotionPayload = {
  kind: "semantic_intent",
  intent: {
    schema_version: "engine.motion_intent.v3",
    profile_id: "profile-adapter-audio",
    profile_revision: 1,
    model_id: "model-adapter-audio",
    mode: "expressive",
    emotion_label: "test",
    axes: {},
  },
};

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

function buildLipSyncRuntimeFactory(options: {
  startOnResume?: boolean;
  onResume?: (callbacks: PlaybackTimelineLipSyncRuntimeCallbacks) => void;
} = {}) {
  return (callbacks: PlaybackTimelineLipSyncRuntimeCallbacks) => {
    let attached = false;
    return {
      attachAudio: () => {
        attached = true;
      },
      resume: async () => {
        if (!attached) {
          return;
        }
        if (options.startOnResume !== false) {
          callbacks.onStarted?.();
        }
        options.onResume?.(callbacks);
      },
      completeAfterAudioEnded: () => {
        callbacks.onTerminal?.("completed", "audio_playback_completed");
      },
      failAfterAudioError: () => {
        callbacks.onTerminal?.("failed", "audio_playback_error");
      },
      stop: () => {},
    };
  };
}

function emitFakeAudioElementCreated(
  callbacks: PlaybackTimelineAudioStartCallbacks,
  audioUrl = "http://127.0.0.1/audio.wav",
): void {
  callbacks.onAudioElementCreated?.({
    audioUrl,
    audio: {} as HTMLAudioElement,
    getAudioCurrentTimeSeconds: () => 0,
    isCurrentAudio: () => true,
  });
}

function buildAudioSink(options: {
  start: (url: string, callbacks: PlaybackTimelineAudioStartCallbacks) => Promise<void>;
  stop?: () => void;
  getClock?: () => AudioPlaybackClock | null;
}): PlaybackTimelineAudioSink {
  return {
    start: options.start,
    stop: options.stop ?? (() => {}),
    getClock: options.getClock ?? (() => ({
      getCurrentTimeMs: () => 0,
      getDurationMs: () => 1000,
      getPlaybackRate: () => 1,
      isPlaying: () => true,
    })),
  };
}

function buildSessionStoreMock(
  overrides: Partial<AdapterAudioRuntimeSessionStore> = {},
): AdapterAudioRuntimeSessionStore {
  return {
    markAudioReleased: () => {},
    markAudioStarted: () => {},
    markAudioDuration: () => {},
    markAudioTerminal: () => {},
    markMotionStarted: () => {},
    markMotionCompleted: () => {},
    markMotionFailed: () => {},
    ...overrides,
  };
}

function getSegmentTimelineSnapshot(
  runtime: ReturnType<typeof createAdapterAudioRuntime>,
  turnId: string | null,
  messageId: string,
) {
  return runtime.getPlaybackTimelineSnapshotForSegment(turnId, messageId);
}

function configureNoopSegmentExecutionPorts(
  runtime: ReturnType<typeof createAdapterAudioRuntime>,
): void {
  runtime.configureSegmentExecution({
    session: {
      markTextReleased: () => {},
      markAudioReleased: () => {},
      markMotionReleased: () => {},
      markMotionFailed: () => {},
      markPhase: () => true,
    },
    textSink: {
      releaseAssistantTextForPlayback: () => true,
    },
    motionSink: {
      start: () => true,
    },
  });
}

async function testAudioPlaybackCreatesAudioClockTimeline(): Promise<void> {
  const state = buildState();
  const startOptionsRef: { current: PlaybackTimelineAudioStartCallbacks | null } = { current: null };
  const sessionEvents: string[] = [];
  const audioTimelineStarted: Array<{
    turnId: string | null;
    messageId: string;
    phase: string | undefined;
    durationMs: number | null | undefined;
  }> = [];
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async (url, callbacks) => {
        emitFakeAudioElementCreated(callbacks, url);
        startOptionsRef.current = callbacks;
        callbacks.onDurationChanged?.(1250);
        callbacks.onPlaybackStarted?.({
          startedAtMs: 100,
          durationMs: 1250,
        });
      },
      getClock: () => ({
        getCurrentTimeMs: () => 320,
        getDurationMs: () => 1250,
        getPlaybackRate: () => 1,
        isPlaying: () => true,
      }),
    }),
    pushHistory: () => {},
    getSessionStore: () => buildSessionStoreMock({
      markAudioReleased: (turnId, messageId) => {
        sessionEvents.push(`released:${turnId ?? ""}:${messageId}`);
      },
      markAudioStarted: (turnId, messageId, startedAtMs, durationMs) => {
        sessionEvents.push(
          `started:${turnId ?? ""}:${messageId}:${startedAtMs ?? ""}:${durationMs ?? ""}`,
        );
      },
      markAudioDuration: (turnId, messageId, durationMs) => {
        sessionEvents.push(`duration:${turnId ?? ""}:${messageId}:${durationMs ?? ""}`);
      },
    }),
    createLipSyncRuntime: buildLipSyncRuntimeFactory(),
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
  const snapshot = getSegmentTimelineSnapshot(runtime, "turn-1", "msg-1");
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
  assert.deepEqual(sessionEvents, [
    "duration:turn-1:msg-1:1250",
    "started:turn-1:msg-1:100:1250",
    "released:turn-1:msg-1",
  ]);
}

async function testAudioTimelineCompletesOnAudioEnded(): Promise<void> {
  const state = buildState();
  const startOptionsRef: { current: PlaybackTimelineAudioStartCallbacks | null } = { current: null };
  const terminalEvents: Array<{
    turnId: string | null;
    terminal: string;
    messageId: string;
    reason?: string;
  }> = [];
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async (url, callbacks) => {
        emitFakeAudioElementCreated(callbacks, url);
        startOptionsRef.current = callbacks;
        callbacks.onDurationChanged?.(900);
        callbacks.onPlaybackStarted?.({
          startedAtMs: 50,
          durationMs: 900,
        });
      },
      getClock: () => ({
        getCurrentTimeMs: () => 900,
        getDurationMs: () => 900,
        getPlaybackRate: () => 1,
        isPlaying: () => true,
      }),
    }),
    pushHistory: () => {},
    getSessionStore: () => buildSessionStoreMock({
      markAudioTerminal: (turnId, terminal, messageId, reason) => {
        terminalEvents.push({
          turnId,
          terminal,
          messageId,
          reason,
        });
      },
    }),
    createLipSyncRuntime: buildLipSyncRuntimeFactory(),
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/audio.wav", "turn-2", "msg-2");
  assert.equal(runtime.releaseAudioForPlayback("msg-2", "turn-2"), true);
  await flushMicrotasks();
  assert.ok(getSegmentTimelineSnapshot(runtime, "turn-2", "msg-2"));

  const options = startOptionsRef.current;
  assert.ok(options);
  options.onEnded?.();

  assert.equal(getSegmentTimelineSnapshot(runtime, "turn-2", "msg-2"), null);
  assert.deepEqual(terminalEvents, [
    {
      turnId: "turn-2",
      terminal: "completed",
      messageId: "msg-2",
      reason: "audio_playback_completed",
    },
  ]);
}

async function testRejectedAudioStartSettlesAdapterState(): Promise<void> {
  const state = buildState();
  const history: string[] = [];
  const terminalEvents: Array<{
    turnId: string | null;
    terminal: string;
    messageId: string;
    reason?: string;
  }> = [];
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async () => {
        throw new Error("autoplay blocked");
      },
    }),
    pushHistory: (role, text) => {
      history.push(`${role}:${text}`);
    },
    getSessionStore: () => buildSessionStoreMock({
      markAudioTerminal: (turnId, terminal, messageId, reason) => {
        terminalEvents.push({
          turnId,
          terminal,
          messageId,
          reason,
        });
      },
    }),
    createLipSyncRuntime: buildLipSyncRuntimeFactory(),
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/blocked.wav", "turn-blocked", "msg-blocked");
  assert.equal(runtime.releaseAudioForPlayback("msg-blocked", "turn-blocked"), true);
  await flushMicrotasks();

  assert.equal(state.isPlayingAudio, false);
  assert.equal(state.audioPlaybackTerminalState, "failed");
  assert.equal(state.audioPlaybackTerminalTurnId, "turn-blocked");
  assert.equal(state.audioPlaybackTerminalReason, "audio_autoplay_blocked");
  assert.equal(getSegmentTimelineSnapshot(runtime, "turn-blocked", "msg-blocked"), null);
  assert.deepEqual(terminalEvents, [
    {
      turnId: "turn-blocked",
      terminal: "failed",
      messageId: "msg-blocked",
      reason: "audio_autoplay_blocked",
    },
  ]);
  assert.equal(state.lastError, "浏览器拒绝自动播放语音。");
  assert.equal(
    history.some((item) => item === "error:音频播放失败。"),
    true,
  );
}

async function testLipSyncFailureRemainsVisibleUntilAudioCompletes(): Promise<void> {
  const state = buildState();
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async (url, callbacks) => {
        emitFakeAudioElementCreated(callbacks, url);
        callbacks.onPlaybackStarted?.({
          startedAtMs: 80,
          durationMs: 1000,
        });
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
    createLipSyncRuntime: buildLipSyncRuntimeFactory({
      startOnResume: false,
      onResume: (callbacks) => {
        callbacks.onTerminal?.("failed", "lip_sync_unavailable");
        callbacks.onTerminal?.("completed", "audio_playback_completed");
      },
    }),
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/audio.wav", "turn-lip", "msg-lip");
  assert.equal(runtime.releaseAudioForPlayback("msg-lip", "turn-lip"), true);
  await flushMicrotasks();

  const snapshot = getSegmentTimelineSnapshot(runtime, "turn-lip", "msg-lip");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "lip_sync")?.terminal, "failed");
  assert.equal(
    snapshot?.sinks.find((sink) => sink.id === "lip_sync")?.reason,
    "lip_sync_unavailable",
  );
}

async function testAudioTimelineInterruptsPreparedAudioOnStopAll(): Promise<void> {
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
      start: async () => new Promise<void>(() => {}),
    }),
    pushHistory: () => {},
    getSessionStore: () => buildSessionStoreMock({
      markAudioTerminal: (turnId, terminal, messageId, reason) => {
        terminalEvents.push({
          turnId,
          terminal,
          messageId,
          reason,
        });
      },
    }),
    createLipSyncRuntime: buildLipSyncRuntimeFactory(),
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/audio.wav", "turn-3", "msg-3");
  assert.equal(runtime.releaseAudioForPlayback("msg-3", "turn-3"), true);
  await flushMicrotasks();
  assert.equal(getSegmentTimelineSnapshot(runtime, "turn-3", "msg-3")?.phase, "preparing");

  runtime.stopAudioAndSettleAll("test_stop_all");

  assert.equal(getSegmentTimelineSnapshot(runtime, "turn-3", "msg-3"), null);
  assert.deepEqual(terminalEvents, [
    {
      turnId: "turn-3",
      terminal: "failed",
      messageId: "msg-3",
      reason: "test_stop_all",
    },
  ]);
}

async function testStopAudioAndSettleTurnFailsOnlyMatchingPendingAudio(): Promise<void> {
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
      start: async () => {},
    }),
    pushHistory: () => {},
    getSessionStore: () => buildSessionStoreMock({
      markAudioTerminal: (turnId, terminal, messageId, reason) => {
        terminalEvents.push({
          turnId,
          terminal,
          messageId,
          reason,
        });
      },
    }),
    createLipSyncRuntime: buildLipSyncRuntimeFactory(),
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/target.wav", "turn-target", "msg-target");
  runtime.queueAudioForPlayback("http://127.0.0.1/other.wav", "turn-other", "msg-other");

  runtime.stopAudioAndSettleTurn("turn-target", "test_turn_settle");

  assert.equal(runtime.hasPendingAudioForTurn("turn-target"), false);
  assert.equal(runtime.hasPendingAudioForTurn("turn-other"), true);
  assert.deepEqual(terminalEvents, [
    {
      turnId: "turn-target",
      terminal: "failed",
      messageId: "msg-target",
      reason: "test_turn_settle",
    },
  ]);
}

async function testStartingNextAudioSettlesInterruptedPreviousSegment(): Promise<void> {
  const state = buildState();
  const terminalEvents: Array<{
    turnId: string | null;
    terminal: string;
    messageId: string;
    reason?: string;
  }> = [];
  const releasedEvents: Array<{
    turnId: string | null;
    messageId: string;
  }> = [];
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async (url, callbacks) => {
        emitFakeAudioElementCreated(callbacks, url);
        callbacks.onPlaybackStarted?.({
          startedAtMs: 100,
          durationMs: 1000,
        });
        return new Promise<void>(() => {});
      },
    }),
    pushHistory: () => {},
    createLipSyncRuntime: buildLipSyncRuntimeFactory(),
    getSessionStore: () => buildSessionStoreMock({
      markAudioReleased: (turnId, messageId) => {
        releasedEvents.push({ turnId, messageId });
      },
      markAudioTerminal: (turnId, terminal, messageId, reason) => {
        terminalEvents.push({
          turnId,
          terminal,
          messageId,
          reason,
        });
      },
    }),
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/first.wav", "turn-4", "msg-4a");
  assert.equal(runtime.releaseAudioForPlayback("msg-4a", "turn-4"), true);
  await flushMicrotasks();
  assert.equal(state.audioPlaybackStartedMessageId, "msg-4a");
  assert.deepEqual(releasedEvents[0], {
    turnId: "turn-4",
    messageId: "msg-4a",
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/second.wav", "turn-4", "msg-4b");
  assert.equal(runtime.releaseAudioForPlayback("msg-4b", "turn-4"), true);
  await flushMicrotasks();

  assert.deepEqual(terminalEvents[0], {
    turnId: "turn-4",
    terminal: "failed",
    messageId: "msg-4a",
    reason: "audio_playback_stopped",
  });
}

async function testTimelineAudioReleaseMarksSessionReleasedOnce(): Promise<void> {
  const state = buildState();
  const releasedEvents: Array<{
    turnId: string | null;
    messageId: string;
  }> = [];
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async (url, callbacks) => {
        emitFakeAudioElementCreated(callbacks, url);
        callbacks.onPlaybackStarted?.({
          startedAtMs: 100,
          durationMs: 1000,
        });
      },
    }),
    pushHistory: () => {},
    createLipSyncRuntime: buildLipSyncRuntimeFactory(),
    getSessionStore: () => buildSessionStoreMock({
      markAudioReleased: (turnId, messageId) => {
        releasedEvents.push({ turnId, messageId });
      },
    }),
  });
  runtime.configureSegmentExecution({
    session: {
      markTextReleased: () => {},
      markAudioReleased: (turnId, messageId) => {
        releasedEvents.push({ turnId, messageId });
      },
      markMotionReleased: () => {},
      markMotionFailed: () => {},
      markPhase: () => true,
    },
    textSink: {
      releaseAssistantTextForPlayback: () => true,
    },
    motionSink: {
      start: () => true,
    },
  });

  runtime.queueAudioForPlayback("http://127.0.0.1/timeline.wav", "turn-timeline-audio", "msg-timeline-audio");
  const result = runtime.startSegmentJob({
    messageId: "msg-timeline-audio",
    turnId: "turn-timeline-audio",
    reason: "test_timeline_audio_release",
    text: {
      release: false,
    },
    audio: {
      release: true,
      noAudioConfirmed: false,
    },
    motion: {
      payload: null,
      receivedAtMs: null,
    },
  });
  await flushMicrotasks();

  assert.equal(result.releasedAudio, true);
  assert.deepEqual(releasedEvents, [
    {
      turnId: "turn-timeline-audio",
      messageId: "msg-timeline-audio",
    },
  ]);
}

async function testMotionSinkKeepsTimelineOpenAfterAudioCompletes(): Promise<void> {
  const state = buildState();
  const startOptionsRef: { current: PlaybackTimelineAudioStartCallbacks | null } = { current: null };
  const runtime = createAdapterAudioRuntime({
    state,
    audioSink: buildAudioSink({
      start: async (url, callbacks) => {
        emitFakeAudioElementCreated(callbacks, url);
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
    createLipSyncRuntime: buildLipSyncRuntimeFactory(),
  });
  configureNoopSegmentExecutionPorts(runtime);

  runtime.queueAudioForPlayback("http://127.0.0.1/audio.wav", "turn-motion", "msg-motion");
  assert.equal(runtime.releaseAudioForPlayback("msg-motion", "turn-motion"), true);
  await flushMicrotasks();

  runtime.startSegmentJob({
    messageId: "msg-motion",
    turnId: "turn-motion",
    reason: "test_motion_after_audio",
    text: {
      release: false,
    },
    audio: {
      release: false,
      noAudioConfirmed: false,
    },
    motion: {
      payload: motionPayload,
      receivedAtMs: 100,
    },
  });
  runtime.markMotionTimelineStarted("turn-motion", "msg-motion");
  startOptionsRef.current?.onEnded?.();

  let snapshot = getSegmentTimelineSnapshot(runtime, "turn-motion", "msg-motion");
  assert.equal(snapshot?.phase, "playing");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "audio")?.terminal, "completed");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal, "started");

  runtime.markMotionTimelineTerminal(
    "turn-motion",
    "msg-motion",
    "completed",
    "motion_completed_after_audio",
  );

  snapshot = getSegmentTimelineSnapshot(runtime, "turn-motion", "msg-motion");
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
    createLipSyncRuntime: buildLipSyncRuntimeFactory(),
  });
  configureNoopSegmentExecutionPorts(runtime);

  runtime.startSegmentJob({
    messageId: "msg-motion-only",
    turnId: "turn-motion-only",
    reason: "test_motion_only",
    text: {
      release: false,
    },
    audio: {
      release: false,
      noAudioConfirmed: true,
    },
    motion: {
      payload: motionPayload,
      receivedAtMs: 100,
    },
  });
  let snapshot = getSegmentTimelineSnapshot(runtime, "turn-motion-only", "msg-motion-only");
  assert.equal(snapshot?.phase, "preparing");
  assert.equal(snapshot?.clockSource, "synthetic");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "motion")?.required, true);
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal, "idle");

  runtime.markMotionTimelineStarted("turn-motion-only", "msg-motion-only");
  snapshot = getSegmentTimelineSnapshot(runtime, "turn-motion-only", "msg-motion-only");
  assert.equal(snapshot?.phase, "playing");
  assert.equal(snapshot?.clockSource, "synthetic");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal, "started");

  runtime.markMotionTimelineTerminal(
    "turn-motion-only",
    "msg-motion-only",
    "completed",
    "motion_only_completed",
  );
  assert.equal(getSegmentTimelineSnapshot(runtime, "turn-motion-only", "msg-motion-only"), null);
}

async function run(): Promise<void> {
  await testAudioPlaybackCreatesAudioClockTimeline();
  await testAudioTimelineCompletesOnAudioEnded();
  await testRejectedAudioStartSettlesAdapterState();
  await testLipSyncFailureRemainsVisibleUntilAudioCompletes();
  await testAudioTimelineInterruptsPreparedAudioOnStopAll();
  await testStopAudioAndSettleTurnFailsOnlyMatchingPendingAudio();
  await testStartingNextAudioSettlesInterruptedPreviousSegment();
  await testTimelineAudioReleaseMarksSessionReleasedOnce();
  await testMotionSinkKeepsTimelineOpenAfterAudioCompletes();
  await testMotionOnlyTimelineUsesSyntheticClock();
  console.log("adapterAudioRuntime tests passed");
}

await run();
