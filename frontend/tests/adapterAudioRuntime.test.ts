import assert from "node:assert/strict";
import {
  createAdapterAudioRuntime as createStrictAdapterAudioRuntime,
} from "../src/adapter-connection/runtime/audioRuntime.js";
import type {
  PlaybackTimelineAudioSink,
  PlaybackTimelineAudioStartCallbacks,
} from "../src/playback-timeline/audioSink.js";
import type { AudioPlaybackClock } from "../src/playback-timeline/contracts.js";
import type {
  PlaybackTimelineLipSyncRuntimeCallbacks,
} from "../src/playback-timeline/lipSyncSink.js";
import type { NormalizedMotionPayload } from "../src/model-engine/contracts.js";
import type {
  PlaybackTimelineSegmentExecutionPorts,
} from "../src/playback-timeline/segmentJob.js";
import { createPlaybackTimelineRuntime } from "../src/playback-timeline/playbackTimelineRuntime.js";
import type {
  PlaybackTimelineAudioSessionPort,
  PlaybackTimelineMotionSessionPort,
  PlaybackTimelineRuntimeDeps,
} from "../src/playback-timeline/playbackTimelineRuntime.js";

interface TestSessionStore
  extends PlaybackTimelineAudioSessionPort, PlaybackTimelineMotionSessionPort {
  markAudioReleased: (turnId: string | null, messageId: string) => void;
}

function createAdapterAudioRuntime(
  deps: Omit<
    Parameters<typeof createStrictAdapterAudioRuntime>[0],
    "playbackTimelineRuntime"
  > & Pick<
    PlaybackTimelineRuntimeDeps<NormalizedMotionPayload>,
    "onAudioTimelineStarted" | "onAudioTimelineDurationReady"
  > & {
    getSessionStore: () => TestSessionStore | undefined;
  },
) {
  let ports: Omit<
    PlaybackTimelineSegmentExecutionPorts<NormalizedMotionPayload>,
    "audioSink"
  > = createNoopSegmentExecutionPorts();
  let runtime: ReturnType<typeof createStrictAdapterAudioRuntime> | null = null;
  const playbackTimelineRuntime = createPlaybackTimelineRuntime<NormalizedMotionPayload>({
    segmentExecution: {
      session: {
        markSessionFailed: (...args) => ports.session.markSessionFailed(...args),
        markTextReleased: (...args) => ports.session.markTextReleased(...args),
        markAudioReleased: (...args) => ports.session.markAudioReleased(...args),
        markMotionReleased: (...args) => ports.session.markMotionReleased(...args),
        markPhase: (...args) => ports.session.markPhase(...args),
      },
      textSink: {
        releaseAssistantTextForPlayback: (...args) =>
          ports.textSink.releaseAssistantTextForPlayback(...args),
        failAssistantTextForPlayback: (...args) =>
          ports.textSink.failAssistantTextForPlayback(...args),
      },
      motionSink: {
        start: (...args) => ports.motionSink.start(...args),
        interrupt: (...args) => ports.motionSink.interrupt(...args),
      },
      audioSink: {
        releaseAudioForPlayback: (...args) => {
          if (!runtime) {
            throw new Error("Adapter audio runtime is not attached.");
          }
          return runtime.releaseAudioForTimelinePlayback(...args);
        },
      },
    },
    get audioSession() {
      return deps.getSessionStore();
    },
    get motionSession() {
      return deps.getSessionStore();
    },
    onAudioTimelineStarted: deps.onAudioTimelineStarted,
    onAudioTimelineDurationReady: deps.onAudioTimelineDurationReady,
  });
  const {
    onAudioTimelineStarted: _onAudioTimelineStarted,
    onAudioTimelineDurationReady: _onAudioTimelineDurationReady,
    getSessionStore: _getSessionStore,
    ...audioRuntimeDeps
  } = deps;
  runtime = createStrictAdapterAudioRuntime({
    ...audioRuntimeDeps,
    playbackTimelineRuntime,
  });
  return Object.assign(runtime, {
    releaseAudioForPlayback(
      audioUrl: string,
      messageId: string,
      turnId: string | null,
    ): boolean {
      const released = runtime?.releaseAudioForTimelinePlayback(
        audioUrl,
        messageId,
        turnId,
      ) ?? false;
      if (released) {
        deps.getSessionStore()?.markAudioReleased(turnId, messageId);
      }
      return released;
    },
    configureSegmentExecution(next: typeof ports) {
      ports = next;
    },
  });
}

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
    clock: {
      getCurrentTimeMs: () => 0,
      getDurationMs: () => 1000,
      getPlaybackRate: () => 1,
      isPlaying: () => false,
    },
    getAudioCurrentTimeSeconds: () => 0,
    isCurrentAudio: () => true,
  });
}

function buildAudioSink(options: {
  start: (url: string, callbacks: PlaybackTimelineAudioStartCallbacks) => Promise<void>;
  stop?: () => void;
}): PlaybackTimelineAudioSink {
  return {
    start: options.start,
    stop: options.stop ?? (() => {}),
  };
}

function createTestAudioClock(
  currentTimeMs = 0,
  durationMs = 1000,
): AudioPlaybackClock {
  return {
    getCurrentTimeMs: () => currentTimeMs,
    getDurationMs: () => durationMs,
    getPlaybackRate: () => 1,
    isPlaying: () => true,
  };
}

function buildSessionStoreMock(
  overrides: Partial<TestSessionStore> = {},
): TestSessionStore {
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

function createNoopSegmentExecutionPorts(): Omit<
  PlaybackTimelineSegmentExecutionPorts<NormalizedMotionPayload>,
  "audioSink"
> {
  return {
    session: {
      markSessionFailed: () => {},
      markTextReleased: () => {},
      markAudioReleased: () => {},
      markMotionReleased: () => {},
      markPhase: () => true,
    },
    textSink: {
      releaseAssistantTextForPlayback: () => true,
      failAssistantTextForPlayback: () => true,
    },
    motionSink: {
      start: () => true,
      interrupt: () => {},
    },
  };
}

function configureNoopSegmentExecutionPorts(
  runtime: ReturnType<typeof createAdapterAudioRuntime>,
): void {
  runtime.configureSegmentExecution(createNoopSegmentExecutionPorts());
}

async function testAudioPlaybackCreatesAudioClockTimeline(): Promise<void> {
  const state = buildState();
  const startOptionsRef: { current: PlaybackTimelineAudioStartCallbacks | null } = { current: null };
  const sessionEvents: string[] = [];
  const clockSourcesBeforeAudioStart: string[] = [];
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
        clockSourcesBeforeAudioStart.push(
          getSegmentTimelineSnapshot(runtime, "turn-1", "msg-1")?.clockSource ?? "missing",
        );
        startOptionsRef.current = callbacks;
        callbacks.onDurationChanged?.(1250);
        callbacks.onPlaybackStarted?.({
          startedAtMs: 100,
          durationMs: 1250,
          clock: createTestAudioClock(320, 1250),
        });
      },
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

  assert.equal(runtime.releaseAudioForPlayback(
    "http://127.0.0.1/audio.wav",
    "msg-1",
    "turn-1",
  ), true);
  await flushMicrotasks();

  assert.ok(startOptionsRef.current);
  assert.deepEqual(clockSourcesBeforeAudioStart, ["audio_pending"]);
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
          clock: createTestAudioClock(900, 900),
        });
      },
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

  assert.equal(runtime.releaseAudioForPlayback(
    "http://127.0.0.1/audio.wav",
    "msg-2",
    "turn-2",
  ), true);
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
        throw Object.assign(new Error("autoplay blocked"), {
          name: "NotAllowedError",
        });
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

  assert.equal(runtime.releaseAudioForPlayback(
    "http://127.0.0.1/blocked.wav",
    "msg-blocked",
    "turn-blocked",
  ), true);
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
          clock: createTestAudioClock(100, 1000),
        });
      },
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

  assert.equal(runtime.releaseAudioForPlayback(
    "http://127.0.0.1/audio.wav",
    "msg-lip",
    "turn-lip",
  ), true);
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

  assert.equal(runtime.releaseAudioForPlayback(
    "http://127.0.0.1/audio.wav",
    "msg-3",
    "turn-3",
  ), true);
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
          clock: createTestAudioClock(),
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

  assert.equal(runtime.releaseAudioForPlayback(
    "http://127.0.0.1/first.wav",
    "msg-4a",
    "turn-4",
  ), true);
  await flushMicrotasks();
  assert.equal(state.audioPlaybackStartedMessageId, "msg-4a");
  assert.deepEqual(releasedEvents[0], {
    turnId: "turn-4",
    messageId: "msg-4a",
  });

  assert.equal(runtime.releaseAudioForPlayback(
    "http://127.0.0.1/second.wav",
    "msg-4b",
    "turn-4",
  ), true);
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
          clock: createTestAudioClock(),
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
      markSessionFailed: () => {},
      markTextReleased: () => {},
      markAudioReleased: (turnId, messageId) => {
        releasedEvents.push({ turnId, messageId });
      },
      markMotionReleased: () => {},
      markPhase: () => true,
    },
    textSink: {
      releaseAssistantTextForPlayback: () => true,
      failAssistantTextForPlayback: () => true,
    },
    motionSink: {
      start: () => true,
      interrupt: () => {},
    },
  });

  const result = runtime.startSegmentJob({
    messageId: "msg-timeline-audio",
    turnId: "turn-timeline-audio",
    reason: "test_timeline_audio_release",
    text: {
      release: false,
      content: null,
    },
    audio: {
      release: true,
      url: "http://127.0.0.1/timeline.wav",
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
          clock: createTestAudioClock(500, 900),
        });
      },
    }),
    pushHistory: () => {},
    getSessionStore: () => undefined,
    createLipSyncRuntime: buildLipSyncRuntimeFactory(),
  });
  configureNoopSegmentExecutionPorts(runtime);

  assert.equal(runtime.releaseAudioForPlayback(
    "http://127.0.0.1/audio.wav",
    "msg-motion",
    "turn-motion",
  ), true);
  await flushMicrotasks();

  runtime.startSegmentJob({
    messageId: "msg-motion",
    turnId: "turn-motion",
    reason: "test_motion_after_audio",
    text: {
      release: false,
      content: null,
    },
    audio: {
      release: false,
      url: null,
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
      content: null,
    },
    audio: {
      release: false,
      url: null,
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
  await testStartingNextAudioSettlesInterruptedPreviousSegment();
  await testTimelineAudioReleaseMarksSessionReleasedOnce();
  await testMotionSinkKeepsTimelineOpenAfterAudioCompletes();
  await testMotionOnlyTimelineUsesSyntheticClock();
  console.log("adapterAudioRuntime tests passed");
}

await run();
