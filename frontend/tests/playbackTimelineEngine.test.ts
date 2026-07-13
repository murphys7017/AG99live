import assert from "node:assert/strict";
import {
  createPlaybackTimelineEngine,
} from "../src/playback-timeline/playbackTimelineEngine.js";
import { resolvePerformanceCurveTimeline } from "../src/model-engine/runtime/playbackClock.js";
import {
  createPlaybackTimelineRuntime as createStrictPlaybackTimelineRuntime,
} from "../src/playback-timeline/playbackTimelineRuntime.js";
import { createTimelineClock } from "../src/playback-timeline/timelineClock.js";
import { createAudioStartMotionTimelineBridge } from "../src/playback-timeline/audioStartMotionBridge.js";
import { createMotionTimelineRunTracker } from "../src/playback-integrations/modelEngineMotionSink.js";
import {
  createQueuedAudioSegmentSink,
  createQueuedTextSegmentSink,
} from "../src/playback-timeline/segmentReleaseSinks.js";
import type {
  AudioPlaybackClock,
  PlaybackTimelineSnapshot,
} from "../src/playback-timeline/contracts.js";
import type { NormalizedMotionPayload } from "../src/model-engine/contracts.js";
import type {
  PlaybackTimelineSegmentExecutionPorts,
} from "../src/playback-timeline/segmentJob.js";

function createPlaybackTimelineRuntime(
  deps: Omit<
    Parameters<typeof createStrictPlaybackTimelineRuntime>[0],
    "segmentExecution"
  >,
) {
  let ports = createNoopSegmentExecutionPorts();
  const runtime = createStrictPlaybackTimelineRuntime({
    ...deps,
    segmentExecution: {
      session: {
        markSessionFailed: (...args) => ports.session.markSessionFailed(...args),
        markTextReleased: (...args) => ports.session.markTextReleased(...args),
        markAudioReleased: (...args) => ports.session.markAudioReleased(...args),
        markMotionReleased: (...args) => ports.session.markMotionReleased(...args),
        markMotionFailed: (...args) => ports.session.markMotionFailed(...args),
        markPhase: (...args) => ports.session.markPhase(...args),
      },
      textSink: {
        releaseAssistantTextForPlayback: (...args) =>
          ports.textSink.releaseAssistantTextForPlayback(...args),
      },
      audioSink: {
        releaseAudioForPlayback: (...args) =>
          ports.audioSink.releaseAudioForPlayback(...args),
      },
      motionSink: {
        start: (...args) => ports.motionSink.start(...args),
        interrupt: (...args) => ports.motionSink.interrupt(...args),
      },
    },
  });
  return Object.assign(runtime, {
    configureSegmentExecution(next: PlaybackTimelineSegmentExecutionPorts) {
      ports = next;
    },
  });
}

function testSyntheticClockLifecycle(): void {
  let nowMs = 100;
  const clock = createTimelineClock({ now: () => nowMs });

  clock.start();
  nowMs = 250;
  assert.equal(clock.snapshot().currentTimeMs, 150);

  clock.pause();
  nowMs = 400;
  assert.equal(clock.snapshot().currentTimeMs, 150);
  assert.equal(clock.snapshot().paused, true);

  clock.resume();
  nowMs = 550;
  assert.equal(clock.snapshot().currentTimeMs, 300);

  clock.stop();
  nowMs = 900;
  assert.equal(clock.snapshot().currentTimeMs, 300);
  assert.equal(clock.snapshot().stopped, true);
}

function testAudioClockTakesPriorityAndExposesUnavailableState(): void {
  let nowMs = 0;
  let audioPlaying = true;
  let audioCurrentTimeMs = 320;
  const audioClock: AudioPlaybackClock = {
    getCurrentTimeMs: () => audioCurrentTimeMs,
    getDurationMs: () => 1200,
    getPlaybackRate: () => 1,
    isPlaying: () => audioPlaying,
  };
  const clock = createTimelineClock({ now: () => nowMs });
  clock.setExpectedDurationMs(900);
  clock.start();
  clock.attachAudioClock(audioClock);

  let snapshot = clock.snapshot();
  assert.equal(snapshot.clockSource, "audio");
  assert.equal(snapshot.currentTimeMs, 320);
  assert.equal(snapshot.durationMs, 1200);

  audioPlaying = false;
  nowMs = 480;
  snapshot = clock.snapshot();
  assert.equal(snapshot.clockSource, "audio_unavailable");
  assert.equal(snapshot.currentTimeMs, 480);
  assert.equal(snapshot.durationMs, 900);

  clock.stop();
  audioPlaying = true;
  audioCurrentTimeMs = 800;
  snapshot = clock.snapshot();
  assert.equal(snapshot.clockSource, "synthetic");
  assert.equal(snapshot.currentTimeMs, 480);
}

function testClockResetClearsPreviousAudioBindingAndDuration(): void {
  let nowMs = 0;
  const clock = createTimelineClock({ now: () => nowMs });
  const audioClock: AudioPlaybackClock = {
    getCurrentTimeMs: () => 250,
    getDurationMs: () => 700,
    getPlaybackRate: () => 1,
    isPlaying: () => true,
  };

  clock.setExpectedDurationMs(900);
  clock.attachAudioClock(audioClock);
  clock.start();
  assert.equal(clock.snapshot().clockSource, "audio");

  clock.reset();
  nowMs = 300;
  const snapshot = clock.snapshot();
  assert.equal(snapshot.clockSource, "synthetic");
  assert.equal(snapshot.currentTimeMs, 0);
  assert.equal(snapshot.durationMs, null);
}

function testTimelineCompletesWhenRequiredSinksSettle(): void {
  let nowMs = 0;
  const engine = createPlaybackTimelineEngine({ now: () => nowMs });
  engine.load(
    { turnId: "turn-1", messageId: "msg-1" },
    [
      { id: "audio", required: true },
      { id: "motion", required: true },
      { id: "lip_sync", required: false },
    ],
  );

  engine.markSinkStarted("audio");
  assert.equal(engine.getPhase(), "preparing");
  engine.markSinkStarted("motion");
  assert.equal(engine.getPhase(), "ready");
  engine.start();
  assert.equal(engine.getPhase(), "playing");

  engine.markSinkTerminal("lip_sync", "failed", "optional_sink_failed");
  assert.equal(engine.getPhase(), "playing");

  nowMs = 100;
  engine.markSinkTerminal("audio", "completed");
  assert.equal(engine.getPhase(), "playing");
  engine.markSinkTerminal("motion", "completed");
  assert.equal(engine.getPhase(), "completed");

  const snapshot = engine.getSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot?.currentTimeMs, 100);
}

function testEngineStartsSinkCallbacksAndPreservesThemAcrossRegister(): void {
  const events: string[] = [];
  const engine = createPlaybackTimelineEngine({ now: () => 0 });
  engine.load(
    { turnId: "turn-start", messageId: "msg-start" },
    [
      {
        id: "audio",
        required: true,
        start: () => {
          events.push("audio_start");
          return true;
        },
      },
    ],
  );

  assert.equal(engine.startSink("audio"), true);

  engine.registerSink({
    id: "audio",
    required: true,
  });
  assert.equal(engine.startSink("audio"), true);
  assert.deepEqual(events, ["audio_start", "audio_start"]);
}

function testTimelineFailsWhenRequiredSinkFails(): void {
  const engine = createPlaybackTimelineEngine({ now: () => 0 });
  engine.load(
    { turnId: "turn-2", messageId: "msg-2" },
    [
      { id: "audio", required: true },
      { id: "motion", required: true },
    ],
  );

  engine.markSinkStarted("audio");
  engine.markSinkStarted("motion");
  engine.start();

  engine.markSinkTerminal("audio", "completed");
  assert.equal(engine.getPhase(), "playing");
  engine.markSinkTerminal("motion", "failed", "compile_failed");
  assert.equal(engine.getPhase(), "failed");
}

function testInterruptPropagatesToActiveSinks(): void {
  const interrupted: string[] = [];
  const engine = createPlaybackTimelineEngine({ now: () => 0 });
  engine.load(
    { turnId: "turn-3", messageId: "msg-3" },
    [
      {
        id: "audio",
        required: true,
        onInterrupt: (reason) => interrupted.push(`audio:${reason}`),
      },
      {
        id: "motion",
        required: true,
        onInterrupt: (reason) => interrupted.push(`motion:${reason}`),
      },
      {
        id: "curve",
        required: false,
        initialTerminal: "absent",
      },
    ],
  );

  engine.markSinkStarted("audio");
  engine.markSinkStarted("motion");
  engine.start();
  engine.interrupt("session_replaced");

  assert.equal(engine.getPhase(), "interrupted");
  assert.deepEqual(interrupted, ["audio:session_replaced", "motion:session_replaced"]);

  const snapshot = engine.getSnapshot();
  assert.ok(snapshot);
  assert.equal(
    snapshot?.sinks.find((sink) => sink.id === "audio")?.terminal,
    "interrupted",
  );
  assert.equal(
    snapshot?.sinks.find((sink) => sink.id === "curve")?.terminal,
    "absent",
  );
}

function testLateSinkEventsDoNotRewriteTerminalTimeline(): void {
  const engine = createPlaybackTimelineEngine({ now: () => 0 });
  engine.load(
    { turnId: "turn-4", messageId: "msg-4" },
    [
      { id: "audio", required: true },
      { id: "motion", required: true },
    ],
  );

  engine.markSinkStarted("audio");
  engine.markSinkStarted("motion");
  engine.start();
  engine.interrupt("session_replaced");

  engine.markSinkTerminal("audio", "completed");
  engine.markSinkStarted("motion");

  const snapshot = engine.getSnapshot();
  assert.equal(engine.getPhase(), "interrupted");
  assert.equal(
    snapshot?.sinks.find((sink) => sink.id === "audio")?.terminal,
    "interrupted",
  );
  assert.equal(
    snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal,
    "interrupted",
  );
}

function testPerformanceCurveTimelineUsesRemainingAudioDuration(): void {
  const resolution = resolvePerformanceCurveTimeline({
    hint: {
      schema_version: "ag99.performance_curve_hint.v1",
      curve_family: "quick_in_hold_soft_out",
      entry: "quick",
      hold: "steady",
      exit: "soft",
      emphasis: "early",
      energy: "medium",
    },
    minRemainingDurationMs: 180,
    clock: {
      timelineId: "timeline-curve",
      turnId: "turn-curve",
      messageId: "msg-curve",
      phase: "playing",
      source: "audio",
      startedAtMs: 100,
      currentTimeMs: 450,
      durationMs: 2000,
    },
  });

  assert.equal(resolution.ok, true);
  if (!resolution.ok) {
    throw new Error("expected performance curve timeline resolution");
  }
  assert.equal(resolution.clockSource, "audio");
  assert.equal(resolution.targetDurationMs, 1550);
  assert.equal(resolution.speechActive, true);
}

function testPerformanceCurveTimelineRejectsUnavailableAudio(): void {
  const resolution = resolvePerformanceCurveTimeline({
    hint: {
      schema_version: "ag99.performance_curve_hint.v1",
      curve_family: "quick_in_hold_soft_out",
      entry: "quick",
      hold: "steady",
      exit: "soft",
      emphasis: "early",
      energy: "medium",
    },
    minRemainingDurationMs: 180,
    clock: {
      timelineId: "timeline-curve",
      turnId: "turn-curve",
      messageId: "msg-curve",
      phase: "playing",
      source: "audio_unavailable",
      startedAtMs: 100,
      currentTimeMs: 450,
      durationMs: 2000,
    },
  });

  assert.equal(resolution.ok, false);
  if (resolution.ok) {
    throw new Error("expected unavailable audio to be rejected");
  }
  assert.equal(resolution.reason, "playback_timeline_audio_unavailable");
}

const testMotionPayload: NormalizedMotionPayload = {
  kind: "semantic_intent",
  intent: {
    schema_version: "engine.motion_intent.v3",
    profile_id: "profile-test",
    profile_revision: 1,
    model_id: "model-test",
    mode: "expressive",
    emotion_label: "test",
    axes: {},
  },
};

function createTestAudioClock(options: {
  currentTimeMs?: number;
  durationMs?: number;
  playing?: boolean;
} = {}): AudioPlaybackClock {
  return {
    getCurrentTimeMs: () => options.currentTimeMs ?? 0,
    getDurationMs: () => options.durationMs ?? 1200,
    getPlaybackRate: () => 1,
    isPlaying: () => options.playing ?? true,
  };
}

function createNoopSegmentExecutionPorts(
  events: string[] = [],
): PlaybackTimelineSegmentExecutionPorts {
  return {
    session: {
      markSessionFailed: () => events.push("session_failed"),
      markTextReleased: () => events.push("text_released"),
      markAudioReleased: () => events.push("audio_released"),
      markMotionReleased: () => events.push("motion_released"),
      markMotionFailed: (_turnId, _messageId, reason) =>
        events.push(`motion_failed:${reason ?? ""}`),
      markPhase: (_turnId, phase) => {
        events.push(`phase:${phase}`);
        return true;
      },
    },
    textSink: {
      releaseAssistantTextForPlayback: () => true,
    },
    audioSink: {
      releaseAudioForPlayback: () => true,
    },
    motionSink: {
      interrupt: (turnId, messageId, reason) => {
        events.push(`motion_interrupt:${turnId}:${messageId}:${reason}`);
      },
      start: (_payload, context) => {
        events.push(`motion_sink:${context.timelineMode ?? ""}`);
        return true;
      },
    },
  };
}

function configureNoopSegmentExecutionPorts(
  runtime: ReturnType<typeof createPlaybackTimelineRuntime>,
  events: string[] = [],
): void {
  runtime.configureSegmentExecution(createNoopSegmentExecutionPorts(events));
}

function startMotionOnlySegment(
  runtime: ReturnType<typeof createPlaybackTimelineRuntime>,
  turnId: string,
  messageId: string,
  events: string[] = [],
): void {
  configureNoopSegmentExecutionPorts(runtime, events);
  runtime.startSegmentJob({
    messageId,
    turnId,
    reason: "test",
    text: {
      release: false,
    },
    audio: {
      release: false,
      noAudioConfirmed: true,
    },
    motion: {
      payload: testMotionPayload,
      receivedAtMs: 10,
    },
  });
}

function prepareTestAudioTimeline(
  runtime: ReturnType<typeof createPlaybackTimelineRuntime>,
  turnId: string,
  messageId: string,
): void {
  runtime.startAudioTimelineSink(turnId, messageId, {
    start: () => true,
  });
}

function testPlaybackTimelineRuntimeCreatesMotionOnlyTimeline(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
  });

  startMotionOnlySegment(runtime, "turn-motion", "msg-motion");
  let snapshot = runtime.getTimelineSnapshotForSegment("turn-motion", "msg-motion");
  assert.equal(snapshot?.phase, "preparing");
  assert.equal(snapshot?.clockSource, "synthetic");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal, "idle");

  runtime.markMotionTimelineStarted("turn-motion", "msg-motion");
  snapshot = runtime.getTimelineSnapshotForSegment("turn-motion", "msg-motion");
  assert.equal(snapshot?.phase, "playing");
  assert.equal(snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal, "started");

  runtime.markMotionTimelineTerminal(
    "turn-motion",
    "msg-motion",
    "completed",
    "motion_completed",
  );
  assert.equal(runtime.getTimelineSnapshotForSegment("turn-motion", "msg-motion"), null);
}

function testPlaybackTimelineRuntimeStopsTurnAndAllRemainingTimelines(): void {
  const failures: string[] = [];
  const executionEvents: string[] = [];
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
    motionSession: {
      markMotionStarted: () => {},
      markMotionCompleted: () => {},
      markMotionFailed: (turnId, messageId, reason) => {
        failures.push(`${turnId}:${messageId}:${reason ?? ""}`);
      },
    },
  });

  startMotionOnlySegment(runtime, "turn-a", "msg-a", executionEvents);
  startMotionOnlySegment(runtime, "turn-b", "msg-b", executionEvents);
  runtime.markMotionTimelineStarted("turn-a", "msg-a");
  runtime.markMotionTimelineStarted("turn-b", "msg-b");

  runtime.stopTimelinesForTurn("turn-a", "connection_closed");
  assert.equal(runtime.getTimelineSnapshotForSegment("turn-a", "msg-a"), null);
  assert.ok(runtime.getTimelineSnapshotForSegment("turn-b", "msg-b"));

  runtime.stopAllTimelines("connection_closed");
  assert.equal(runtime.getTimelineSnapshotForSegment("turn-b", "msg-b"), null);
  assert.deepEqual(failures, [
    "turn-a:msg-a:connection_closed",
    "turn-b:msg-b:connection_closed",
  ]);
  assert.deepEqual(executionEvents.filter((item) => item.startsWith("motion_interrupt:")), [
    "motion_interrupt:turn-a:msg-a:connection_closed",
    "motion_interrupt:turn-b:msg-b:connection_closed",
  ]);
}

function testPlaybackTimelineRuntimePreparesSegmentJobIdempotently(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
  });
  const events: string[] = [];
  configureNoopSegmentExecutionPorts(runtime, events);

  prepareTestAudioTimeline(runtime, "turn-segment", "msg-segment");
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-segment", "msg-segment")
      ?.sinks.some((sink) => sink.id === "motion"),
    false,
  );

  runtime.startSegmentJob({
    messageId: "msg-segment",
    turnId: "turn-segment",
    reason: "test",
    text: {
      release: false,
    },
    audio: {
      release: false,
      noAudioConfirmed: false,
    },
    motion: {
      payload: testMotionPayload,
      receivedAtMs: 10,
    },
  });
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-segment", "msg-segment")
      ?.sinks.some((sink) => sink.id === "motion" && sink.required),
    true,
  );

  prepareTestAudioTimeline(runtime, "turn-segment", "msg-segment");
  const snapshot = runtime.getTimelineSnapshotForSegment(
    "turn-segment",
    "msg-segment",
  );
  assert.equal(
    snapshot?.sinks.some((sink) => sink.id === "motion" && sink.required),
    true,
  );
}

function testMotionTimelineEventsDoNotPrepareMissingSink(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
  });

  prepareTestAudioTimeline(runtime, "turn-no-motion-sink", "msg-no-motion-sink");
  runtime.markMotionTimelineStarted("turn-no-motion-sink", "msg-no-motion-sink");
  runtime.markMotionTimelineTerminal(
    "turn-no-motion-sink",
    "msg-no-motion-sink",
    "completed",
    "unexpected_motion_terminal",
  );

  const snapshot = runtime.getTimelineSnapshotForSegment(
    "turn-no-motion-sink",
    "msg-no-motion-sink",
  );
  assert.equal(
    snapshot?.sinks.some((sink) => sink.id === "motion"),
    false,
  );
  assert.equal(snapshot?.phase, "preparing");
}

function testAudioAndLipSyncEventsDoNotMutateMissingSinks(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
  });

  startMotionOnlySegment(runtime, "turn-motion-only", "msg-motion-only");
  runtime.markAudioTimelineDuration("turn-motion-only", "msg-motion-only", 1200);
  runtime.markAudioTimelineStarted("turn-motion-only", "msg-motion-only", 100, 1200);
  runtime.markLipSyncTimelineStarted("turn-motion-only", "msg-motion-only");
  runtime.markLipSyncTimelineTerminal(
    "turn-motion-only",
    "msg-motion-only",
    "failed",
    "unexpected_lip_sync_terminal",
  );
  runtime.markAudioTimelineTerminal(
    "turn-motion-only",
    "msg-motion-only",
    "completed",
    "unexpected_audio_terminal",
  );

  const snapshot = runtime.getTimelineSnapshotForSegment(
    "turn-motion-only",
    "msg-motion-only",
  );
  assert.equal(snapshot?.phase, "preparing");
  assert.equal(snapshot?.durationMs, null);
  assert.equal(
    snapshot?.sinks.some((sink) => sink.id === "audio" || sink.id === "lip_sync"),
    false,
  );
  assert.equal(
    snapshot?.sinks.find((sink) => sink.id === "motion")?.terminal,
    "idle",
  );
}

function testPlaybackTimelineRuntimeStartsSegmentJobThroughTimelineEntry(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
  });
  const events: string[] = [];
  runtime.configureSegmentExecution({
    session: {
      markSessionFailed: () => events.push("session_failed"),
      markTextReleased: () => events.push("text_released"),
      markAudioReleased: () => events.push("audio_released"),
      markMotionReleased: () => events.push("motion_released"),
      markMotionFailed: () => events.push("motion_failed"),
      markPhase: (_turnId, phase) => {
        events.push(`phase:${phase}`);
        return true;
      },
    },
    textSink: {
      releaseAssistantTextForPlayback: () => true,
    },
    audioSink: {
      releaseAudioForPlayback: () => true,
    },
    motionSink: {
      interrupt: () => {},
      start: (_payload, context) => {
        events.push(`motion_sink:${context.timelineMode ?? ""}`);
        return true;
      },
    },
  });
  const result = runtime.startSegmentJob(
    {
      messageId: "msg-runtime-start",
      turnId: "turn-runtime-start",
      reason: "test",
      text: {
        release: false,
      },
      audio: {
        release: false,
        noAudioConfirmed: true,
      },
      motion: {
        payload: {
          kind: "semantic_intent",
          intent: {
            schema_version: "engine.motion_intent.v3",
            profile_id: "profile-runtime-start",
            profile_revision: 1,
            model_id: "model-runtime-start",
            mode: "expressive",
            emotion_label: "test",
            axes: {},
          },
        },
        receivedAtMs: 10,
      },
    },
  );

  assert.deepEqual(result, {
    releasedText: false,
    releasedAudio: false,
    releasedMotion: true,
  });
  assert.deepEqual(events, [
    "motion_sink:motion_only",
    "motion_released",
    "phase:playing",
  ]);
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-runtime-start", "msg-runtime-start")
      ?.sinks.find((sink) => sink.id === "motion")?.required,
    true,
  );
}

function testQueuedSegmentReleaseSinksConsumePendingItems(): void {
  const pendingAssistantTexts = new Map();
  const pendingAudios = new Map();
  pendingAssistantTexts.set("6:turn-q:msg-q", {
    turnId: "turn-q",
    messageId: "msg-q",
    receivedAtMs: 1,
    text: "  hello timeline  ",
  });
  pendingAudios.set("6:turn-q:msg-q", {
    turnId: "turn-q",
    messageId: "msg-q",
    receivedAtMs: 2,
    audioUrl: "  http://127.0.0.1/audio.wav  ",
  });

  const events: string[] = [];
  const textSink = createQueuedTextSegmentSink({
    state: {
      pendingAssistantTexts,
      assistantTextDeliveryTurnId: null,
      statusMessage: "",
    },
    updateAssistantText: (text, turnId) => {
      events.push(`text:${turnId ?? ""}:${text}`);
    },
    markTextDelivered: (turnId, messageId) => {
      events.push(`text_delivered:${turnId ?? ""}:${messageId}`);
    },
  });
  const audioSink = createQueuedAudioSegmentSink({
    state: {
      pendingAudios,
    },
    startAudioPlayback: (audioUrl, turnId, messageId) => {
      events.push(`audio:${turnId ?? ""}:${messageId}:${audioUrl}`);
    },
  });

  assert.equal(textSink.releaseAssistantTextForPlayback("msg-q", "turn-q"), true);
  assert.equal(audioSink.releaseAudioForPlayback("msg-q", "turn-q"), true);
  assert.equal(pendingAssistantTexts.size, 0);
  assert.equal(pendingAudios.size, 0);
  assert.deepEqual(events, [
    "text:turn-q:hello timeline",
    "text_delivered:turn-q:msg-q",
    "audio:turn-q:msg-q:http://127.0.0.1/audio.wav",
  ]);
}

function testPlaybackTimelineRuntimeKeepsMismatchedSegmentTimelinesSeparate(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
  });

  prepareTestAudioTimeline(runtime, "turn-audio", "msg-audio");
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-motion", "msg-motion"),
    null,
  );
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-audio", "msg-audio")?.messageId,
    "msg-audio",
  );

  startMotionOnlySegment(runtime, "turn-motion", "msg-motion");
  const motionSnapshot = runtime.getTimelineSnapshotForSegment("turn-motion", "msg-motion");
  assert.equal(motionSnapshot?.messageId, "msg-motion");
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-audio", "msg-audio")?.messageId,
    "msg-audio",
  );
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-motion", "msg-motion")?.messageId,
    "msg-motion",
  );
}

function testPlaybackTimelineRuntimeClearsOnlyTerminalSegmentTimeline(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
  });

  prepareTestAudioTimeline(runtime, "turn-audio", "msg-audio");
  startMotionOnlySegment(runtime, "turn-motion", "msg-motion");
  runtime.markMotionTimelineStarted("turn-motion", "msg-motion");
  runtime.markMotionTimelineTerminal(
    "turn-motion",
    "msg-motion",
    "completed",
    "motion_completed",
  );

  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-motion", "msg-motion"),
    null,
  );
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-audio", "msg-audio")?.messageId,
    "msg-audio",
  );
}

function testPlaybackTimelineRuntimeExposesMissingAudioClock(): void {
  const terminalEvents: string[] = [];
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
    audioSession: {
      markAudioStarted: () => {},
      markAudioDuration: () => {},
      markAudioTerminal: (_turnId, terminal, messageId, reason) => {
        terminalEvents.push(`${terminal}:${messageId}:${reason ?? ""}`);
      },
    },
  });

  prepareTestAudioTimeline(runtime, "turn-audio", "msg-audio");
  runtime.markAudioTimelineStarted("turn-audio", "msg-audio", 100, 1200);

  const snapshot = runtime.getTimelineSnapshotForSegment("turn-audio", "msg-audio");
  assert.equal(snapshot, null);
  assert.deepEqual(terminalEvents, [
    "failed:msg-audio:audio_clock_unavailable_on_started",
  ]);
}

function testPlaybackTimelineRuntimeStopsOnlyRequestedSegmentTimeline(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
  });

  prepareTestAudioTimeline(runtime, "turn-audio", "msg-audio");
  startMotionOnlySegment(runtime, "turn-motion", "msg-motion");

  runtime.stopTimelineForSegment(
    "turn-motion",
    "msg-motion",
    "test_segment_stop",
  );

  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-motion", "msg-motion"),
    null,
  );
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-audio", "msg-audio")?.messageId,
    "msg-audio",
  );
}

function testPlaybackTimelineRuntimeFindsActiveAudioSegments(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => createTestAudioClock(),
  });

  prepareTestAudioTimeline(runtime, "turn-active", "msg-active");
  prepareTestAudioTimeline(runtime, "turn-idle", "msg-idle");
  assert.deepEqual(runtime.findActiveAudioTimelineSegments(), []);

  runtime.markAudioTimelineStarted("turn-active", "msg-active", 100, 1200);
  assert.deepEqual(runtime.findActiveAudioTimelineSegments(), [
    { turnId: "turn-active", messageId: "msg-active" },
  ]);

  runtime.markAudioTimelineTerminal(
    "turn-active",
    "msg-active",
    "completed",
    "audio_playback_completed",
  );
  assert.deepEqual(runtime.findActiveAudioTimelineSegments(), []);
}

function testPlaybackTimelineRuntimeFindsOpenAudioSegments(): void {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => createTestAudioClock(),
  });

  prepareTestAudioTimeline(runtime, "turn-open", "msg-open");
  assert.deepEqual(runtime.findActiveAudioTimelineSegments(), []);
  assert.deepEqual(runtime.findOpenAudioTimelineSegments(), [
    { turnId: "turn-open", messageId: "msg-open" },
  ]);

  runtime.markAudioTimelineStarted("turn-open", "msg-open", 100, 1200);
  assert.deepEqual(runtime.findOpenAudioTimelineSegments(), [
    { turnId: "turn-open", messageId: "msg-open" },
  ]);

  runtime.markAudioTimelineTerminal(
    "turn-open",
    "msg-open",
    "completed",
    "audio_playback_completed",
  );
  assert.deepEqual(runtime.findOpenAudioTimelineSegments(), []);
}

function testPlaybackTimelineRuntimeDoesNotRewriteAudioSessionTerminal(): void {
  const events: string[] = [];
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => createTestAudioClock(),
    audioSession: {
      markAudioStarted: () => {},
      markAudioDuration: () => {},
      markAudioTerminal: (_turnId, terminal, messageId, reason) => {
        events.push(`${terminal}:${messageId}:${reason ?? ""}`);
      },
    },
  });

  prepareTestAudioTimeline(runtime, "turn-audio-terminal", "msg-audio-terminal");
  runtime.markAudioTimelineStarted("turn-audio-terminal", "msg-audio-terminal", 100, 1200);
  runtime.markAudioTimelineTerminal(
    "turn-audio-terminal",
    "msg-audio-terminal",
    "completed",
    "audio_playback_completed",
  );
  runtime.markAudioTimelineTerminal(
    "turn-audio-terminal",
    "msg-audio-terminal",
    "failed",
    "late_audio_error",
  );

  assert.deepEqual(events, [
    "completed:msg-audio-terminal:audio_playback_completed",
  ]);
}

function testPlaybackTimelineRuntimeWritesMotionSessionLifecycle(): void {
  const events: string[] = [];
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
    motionSession: {
      markMotionStarted: (_turnId, messageId) => {
        events.push(`started:${messageId}`);
      },
      markMotionCompleted: (_turnId, messageId) => {
        events.push(`completed:${messageId}`);
      },
      markMotionFailed: (_turnId, messageId, reason) => {
        events.push(`failed:${messageId}:${reason ?? ""}`);
      },
    },
  });

  startMotionOnlySegment(runtime, "turn-motion-session", "msg-motion-session");
  runtime.markMotionTimelineStarted("turn-motion-session", "msg-motion-session");
  runtime.markMotionTimelineTerminal(
    "turn-motion-session",
    "msg-motion-session",
    "completed",
    "motion_completed",
  );
  runtime.markMotionTimelineTerminal(
    "turn-motion-session",
    "msg-motion-session",
    "failed",
    "late_motion_error",
  );

  assert.deepEqual(events, [
    "started:msg-motion-session",
    "completed:msg-motion-session",
  ]);
}

function testTerminalSinkEventsAreStable(): void {
  const engine = createPlaybackTimelineEngine({ now: () => 0 });
  engine.load(
    { turnId: "turn-5", messageId: "msg-5" },
    [
      { id: "audio", required: true },
      { id: "lip_sync", required: false },
    ],
  );

  engine.markSinkStarted("audio");
  engine.start();
  engine.markSinkTerminal("lip_sync", "failed", "lip_sync_unavailable");
  engine.markSinkTerminal("lip_sync", "completed", "audio_playback_completed");
  engine.markSinkStarted("lip_sync");

  const lipSyncSink = engine.getSnapshot()?.sinks.find((sink) => sink.id === "lip_sync");
  assert.equal(lipSyncSink?.terminal, "failed");
  assert.equal(lipSyncSink?.reason, "lip_sync_unavailable");
}

function testClosedTimelineHistoryIsBounded(): void {
  const failures: string[] = [];
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
    motionSession: {
      markMotionStarted: () => {},
      markMotionCompleted: () => {},
      markMotionFailed: (_turnId, messageId, reason) => {
        failures.push(`${messageId}:${reason ?? ""}`);
      },
    },
  });
  for (let index = 0; index < 513; index += 1) {
    const messageId = `msg-closed-${index}`;
    startMotionOnlySegment(runtime, "turn-closed-history", messageId);
    runtime.stopTimelineForSegment(
      "turn-closed-history",
      messageId,
      "test_cleanup",
    );
  }
  failures.length = 0;

  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    runtime.markMotionTimelineStarted("turn-closed-history", "msg-closed-0");
    runtime.markMotionTimelineStarted("turn-closed-history", "msg-closed-512");
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }

  assert.deepEqual(failures, [
    "msg-closed-0:playback_timeline_missing_motion_sink:motion.started",
  ]);
}

function buildTimelineSnapshot(
  currentTimeMs: number,
): PlaybackTimelineSnapshot {
  return {
    timelineId: `timeline-${currentTimeMs}`,
    turnId: "turn-audio",
    messageId: "msg-audio",
    phase: "playing",
    clockSource: "audio",
    startedAtMs: 10,
    currentTimeMs,
    durationMs: 1200,
    playbackRate: 1,
    sinks: [],
  };
}

function testAudioStartMotionBridgeRefreshesTimelineAtFireTime(): void {
  const scheduled: Array<() => void> = [];
  let snapshot = buildTimelineSnapshot(100);
  const started: PlaybackTimelineSnapshot[] = [];
  const lifecycleOrder: string[] = [];
  const bridge = createAudioStartMotionTimelineBridge({
    delayMs: 90,
    schedule: (_delayMs, fn) => {
      scheduled.push(fn);
      return "timer-1";
    },
    clearSchedule: () => {},
    ensureMotionTimelineSinkForSegment: () => {
      lifecycleOrder.push("ensure-motion-sink");
      snapshot = {
        ...snapshot,
        sinks: [{ id: "motion", required: true, terminal: "idle" }],
      };
      return true;
    },
    getPlaybackTimelineSnapshotForSegment: () => {
      lifecycleOrder.push("refresh-timeline");
      return snapshot;
    },
    handlePlaybackTimelineStarted: (_turnId, _messageId, playbackTimeline) => {
      lifecycleOrder.push("start-model-engine");
      if (playbackTimeline) {
        started.push(playbackTimeline);
      }
    },
  });

  bridge.handleAudioTimelineStarted("turn-audio", "msg-audio");
  snapshot = buildTimelineSnapshot(220);
  scheduled[0]?.();

  assert.equal(started.length, 1);
  assert.equal(started[0].currentTimeMs, 220);
  assert.deepEqual(lifecycleOrder, [
    "ensure-motion-sink",
    "refresh-timeline",
    "start-model-engine",
  ]);
  assert.equal(started[0].sinks[0]?.id, "motion");
  assert.equal(started[0].sinks[0]?.required, true);
}

function testAudioStartMotionBridgeCanCancelPendingWakeup(): void {
  const cleared: unknown[] = [];
  const scheduled: Array<() => void> = [];
  let started = false;
  const bridge = createAudioStartMotionTimelineBridge({
    schedule: (_delayMs, fn) => {
      scheduled.push(fn);
      return "timer-clear";
    },
    clearSchedule: (timer) => {
      cleared.push(timer);
    },
    ensureMotionTimelineSinkForSegment: () => true,
    getPlaybackTimelineSnapshotForSegment: () => buildTimelineSnapshot(0),
    handlePlaybackTimelineStarted: () => {
      started = true;
    },
  });

  bridge.handleAudioTimelineStarted("turn-audio", "msg-audio");
  bridge.clear();
  scheduled[0]?.();

  assert.deepEqual(cleared, ["timer-clear"]);
  assert.equal(started, false);
}

function testAudioStartMotionBridgeSkipsStaleSegment(): void {
  const scheduled: Array<() => void> = [];
  let started = false;
  const bridge = createAudioStartMotionTimelineBridge({
    schedule: (_delayMs, fn) => {
      scheduled.push(fn);
      return "timer-stale";
    },
    clearSchedule: () => {},
    canStartMotionForAudioTimeline: () => false,
    ensureMotionTimelineSinkForSegment: () => true,
    getPlaybackTimelineSnapshotForSegment: () => buildTimelineSnapshot(0),
    handlePlaybackTimelineStarted: () => {
      started = true;
    },
  });

  bridge.handleAudioTimelineStarted("turn-audio", "msg-audio");
  scheduled[0]?.();

  assert.equal(started, false);
}

function testAudioStartMotionBridgeReportsMissingTimeline(): void {
  const scheduled: Array<() => void> = [];
  let started = false;
  const missing: Array<{ turnId: string; messageId: string }> = [];
  const bridge = createAudioStartMotionTimelineBridge({
    schedule: (_delayMs, fn) => {
      scheduled.push(fn);
      return "timer-missing";
    },
    clearSchedule: () => {},
    ensureMotionTimelineSinkForSegment: () => true,
    getPlaybackTimelineSnapshotForSegment: () => null,
    onMissingPlaybackTimeline: (turnId, messageId) => {
      missing.push({ turnId, messageId });
    },
    handlePlaybackTimelineStarted: () => {
      started = true;
    },
  });

  bridge.handleAudioTimelineStarted("turn-audio", "msg-audio");
  scheduled[0]?.();

  assert.equal(started, false);
  assert.deepEqual(missing, [{ turnId: "turn-audio", messageId: "msg-audio" }]);
}

function testMotionTimelineRunTrackerMarksStartedAndTerminalByRunId(): void {
  const events: string[] = [];
  const tracker = createMotionTimelineRunTracker({
    markMotionTimelineStarted: (turnId, messageId) => {
      events.push(`started:${turnId}:${messageId}`);
    },
    markMotionTimelineTerminal: (turnId, messageId, terminal, reason) => {
      events.push(`terminal:${turnId}:${messageId}:${terminal}:${reason}`);
    },
  });

  tracker.recordStarted({
    model: null,
    messageId: "msg-motion",
    turnId: "turn-motion",
    playbackTurnId: "turn-motion",
    startReason: "timeline",
    queuedDelayMs: 0,
    payloadKind: "semantic_plan",
    diagnostics: null,
    playerMessage: "playing",
    runId: "run-motion",
    plan: {
      schema_version: "engine.parameter_plan.v2",
      profile_id: "profile-test",
      profile_revision: 1,
      model_id: "model-test",
      mode: "expressive",
      emotion_label: "test",
      parameters: [],
      timing: { duration_ms: 1000, blend_in_ms: 100, hold_ms: 800, blend_out_ms: 100 },
    },
    motion: null,
  });
  tracker.recordTerminal({ runId: "run-motion", status: "stopped", reason: "interrupted" });

  assert.deepEqual(events, [
    "started:turn-motion:msg-motion",
    "terminal:turn-motion:msg-motion:interrupted:interrupted",
  ]);
}

function testMotionTimelineRunTrackerIgnoresPreviewUnknownAndClearedRuns(): void {
  const events: string[] = [];
  const tracker = createMotionTimelineRunTracker({
    markMotionTimelineStarted: (turnId, messageId) => {
      events.push(`started:${turnId}:${messageId}`);
    },
    markMotionTimelineTerminal: (turnId, messageId, terminal, reason) => {
      events.push(`terminal:${turnId}:${messageId}:${terminal}:${reason}`);
    },
  });

  tracker.recordStarted({
    model: null,
    messageId: "msg-preview",
    turnId: "turn-preview",
    playbackTurnId: "turn-preview",
    startReason: "preview",
    queuedDelayMs: 0,
    payloadKind: "semantic_plan",
    diagnostics: null,
    playerMessage: "preview",
    runId: "run-preview",
    plan: {
      schema_version: "engine.parameter_plan.v2",
      profile_id: "profile-test",
      profile_revision: 1,
      model_id: "model-test",
      mode: "expressive",
      emotion_label: "test",
      parameters: [],
      timing: { duration_ms: 1000, blend_in_ms: 100, hold_ms: 800, blend_out_ms: 100 },
    },
    motion: null,
  });
  tracker.recordTerminal({ runId: "run-preview", status: "completed" });
  tracker.recordTerminal({ runId: "missing", status: "failed", reason: "missing" });

  tracker.recordStarted({
    model: null,
    messageId: "msg-clear",
    turnId: "turn-clear",
    playbackTurnId: "turn-clear",
    startReason: "timeline",
    queuedDelayMs: 0,
    payloadKind: "semantic_plan",
    diagnostics: null,
    playerMessage: "playing",
    runId: "run-clear",
    plan: {
      schema_version: "engine.parameter_plan.v2",
      profile_id: "profile-test",
      profile_revision: 1,
      model_id: "model-test",
      mode: "expressive",
      emotion_label: "test",
      parameters: [],
      timing: { duration_ms: 1000, blend_in_ms: 100, hold_ms: 800, blend_out_ms: 100 },
    },
    motion: null,
  });
  tracker.clear();
  tracker.recordTerminal({ runId: "run-clear", status: "completed" });

  assert.deepEqual(events, ["started:turn-clear:msg-clear"]);
}
function run(): void {
  testSyntheticClockLifecycle();
  testAudioClockTakesPriorityAndExposesUnavailableState();
  testClockResetClearsPreviousAudioBindingAndDuration();
  testTimelineCompletesWhenRequiredSinksSettle();
  testEngineStartsSinkCallbacksAndPreservesThemAcrossRegister();
  testTimelineFailsWhenRequiredSinkFails();
  testInterruptPropagatesToActiveSinks();
  testLateSinkEventsDoNotRewriteTerminalTimeline();
  testPerformanceCurveTimelineUsesRemainingAudioDuration();
  testPerformanceCurveTimelineRejectsUnavailableAudio();
  testPlaybackTimelineRuntimeCreatesMotionOnlyTimeline();
  testPlaybackTimelineRuntimeStopsTurnAndAllRemainingTimelines();
  testPlaybackTimelineRuntimePreparesSegmentJobIdempotently();
  testMotionTimelineEventsDoNotPrepareMissingSink();
  testAudioAndLipSyncEventsDoNotMutateMissingSinks();
  testPlaybackTimelineRuntimeStartsSegmentJobThroughTimelineEntry();
  testQueuedSegmentReleaseSinksConsumePendingItems();
  testPlaybackTimelineRuntimeKeepsMismatchedSegmentTimelinesSeparate();
  testPlaybackTimelineRuntimeClearsOnlyTerminalSegmentTimeline();
  testPlaybackTimelineRuntimeExposesMissingAudioClock();
  testPlaybackTimelineRuntimeStopsOnlyRequestedSegmentTimeline();
  testPlaybackTimelineRuntimeFindsActiveAudioSegments();
  testPlaybackTimelineRuntimeFindsOpenAudioSegments();
  testPlaybackTimelineRuntimeDoesNotRewriteAudioSessionTerminal();
  testPlaybackTimelineRuntimeWritesMotionSessionLifecycle();
  testTerminalSinkEventsAreStable();
  testClosedTimelineHistoryIsBounded();
  testAudioStartMotionBridgeRefreshesTimelineAtFireTime();
  testAudioStartMotionBridgeCanCancelPendingWakeup();
  testAudioStartMotionBridgeSkipsStaleSegment();
  testAudioStartMotionBridgeReportsMissingTimeline();
  testMotionTimelineRunTrackerMarksStartedAndTerminalByRunId();
  testMotionTimelineRunTrackerIgnoresPreviewUnknownAndClearedRuns();
  console.log("playbackTimelineEngine tests passed");
}

run();
