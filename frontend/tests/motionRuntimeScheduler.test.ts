// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;
(globalThis as Record<string, unknown>).performance = {
  now: () => mockNowMs,
};

import assert from "node:assert/strict";
import {
  createMotionRuntimeScheduler,
  type StartPayloadContext,
} from "../src/model-engine/runtime/motionRuntimeScheduler.js";
import type {
  ModelEnginePlaybackSession,
} from "../src/model-engine/runtime/contracts.js";
import type { NormalizedMotionPayload } from "../src/model-engine/contracts.js";
import type { PlaybackTimelineSnapshot } from "../src/playback-timeline/contracts.js";

let mockNowMs = 1000;
let nextTimerId = 1;
const timers = new Map<number, () => void>();

function resetTimers(): void {
  timers.clear();
  nextTimerId = 1;
}

window.setTimeout = ((handler: TimerHandler, _timeout?: number) => {
  const id = nextTimerId++;
  timers.set(id, () => {
    if (typeof handler === "function") {
      handler();
    }
  });
  return id;
}) as typeof window.setTimeout;

window.clearTimeout = ((id?: number) => {
  if (typeof id === "number") {
    timers.delete(id);
  }
}) as typeof window.clearTimeout;

function buildPayload(): NormalizedMotionPayload {
  return {
    kind: "semantic_intent",
    intent: {
      schema_version: "engine.motion_intent.v3",
      profile_id: "profile-1",
      profile_revision: 1,
      model_id: "model-1",
      mode: "expressive",
      emotion_label: "happy",
      duration_hint_ms: 1000,
      axes: {
        head_yaw: 62,
      },
    },
  };
}

function buildCurvePayload(): NormalizedMotionPayload {
  const payload = buildPayload();
  if (payload.kind !== "semantic_intent") {
    throw new Error("expected semantic_intent payload");
  }
  return {
    ...payload,
    intent: {
      ...payload.intent,
      performance_curve_hint: {
        schema_version: "ag99.performance_curve_hint.v1",
        curve_family: "quick_in_hold_soft_out",
        entry: "quick",
        hold: "steady",
        exit: "soft",
        emphasis: "early",
        energy: "medium",
      },
    },
  };
}

function buildTimelineSnapshot(overrides: Partial<PlaybackTimelineSnapshot> = {}): PlaybackTimelineSnapshot {
  return {
    timelineId: "timeline-1",
    turnId: "turn-1",
    messageId: "msg-1",
    phase: "playing",
    clockSource: "audio",
    startedAtMs: 1200,
    currentTimeMs: 420,
    durationMs: 2400,
    playbackRate: 1,
    sinks: [
      {
        id: "audio",
        required: true,
        terminal: "started",
      },
    ],
    ...overrides,
  };
}

function buildSession(audioTerminal: "idle" | "completed" = "idle"): ModelEnginePlaybackSession {
  return {
    id: "turn:turn-1",
    turnId: "turn-1",
    segmentOrder: ["msg-1"],
    segments: new Map([
      [
        "msg-1",
        {
          messageId: "msg-1",
          turnId: "turn-1",
          audio: {
            released: true,
            started: true,
            startedAtMs: 800,
            durationMs: 2000,
            terminal: audioTerminal,
          },
        },
      ],
    ]),
  };
}

function createHarness(session: ModelEnginePlaybackSession) {
  const started: StartPayloadContext[] = [];
  const failed: StartPayloadContext[] = [];
  const scheduler = createMotionRuntimeScheduler(
    {
      getCurrentTurnId: () => "turn-1",
      sessionStore: {
        getActiveSession: () => session,
        getSessionByTurnId: () => session,
      },
    },
    {
      onPendingStateChanged: () => {},
      onPendingStatus: () => {},
      onStartPayload: (_payload, context) => {
        started.push(context);
        return true;
      },
      onStartFailed: (context) => {
        failed.push(context);
      },
    },
  );
  return { scheduler, started, failed };
}

function setAudioWaiting(session: ModelEnginePlaybackSession): void {
  const segment = session.segments.get("msg-1");
  if (!segment) {
    throw new Error("missing test segment");
  }
  segment.audio.started = false;
  segment.audio.startedAtMs = null;
  segment.audio.durationMs = null;
  segment.audio.terminal = "idle";
}

function testQueuedPayloadFailsWhenTimelineDoesNotArrive(): void {
  resetTimers();
  const { scheduler, started, failed } = createHarness(buildSession("completed"));

  scheduler.queueInboundPayload(buildPayload(), {
    messageId: "msg-queued",
    turnId: " turn-1 ",
    playbackTurnId: " turn-1 ",
    receivedAtMs: 900,
  });

  const timer = timers.values().next().value;
  assert.ok(timer);
  timer();

  assert.equal(started.length, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].turnId, "turn-1");
  assert.equal(failed[0].playbackTurnId, "turn-1");
  assert.equal(failed[0].startReason, "playback_timeline_missing_before_motion_start");
}

function testQueuedPayloadFailureRetainsPreparingTimelineOwnership(): void {
  resetTimers();
  const session = buildSession();
  setAudioWaiting(session);
  const { scheduler, started, failed } = createHarness(session);
  const preparingTimeline = buildTimelineSnapshot({
    phase: "preparing",
    startedAtMs: null,
    currentTimeMs: 0,
    durationMs: null,
  });

  scheduler.queueInboundPayload(buildPayload(), {
    messageId: "msg-1",
    turnId: "turn-1",
    playbackTurnId: "turn-1",
    receivedAtMs: 900,
    playbackTimeline: preparingTimeline,
  });

  const timer = timers.values().next().value;
  assert.ok(timer);
  timer();

  assert.equal(started.length, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].playbackTimeline?.timelineId, "timeline-1");
  assert.equal(failed[0].playbackTimeline?.phase, "preparing");
}

function testDroppedPendingPayloadReportsStartFailure(): void {
  resetTimers();
  const { scheduler, started, failed } = createHarness(buildSession("completed"));

  scheduler.queueInboundPayload(buildPayload(), {
    messageId: "msg-dropped",
    turnId: "turn-1",
    playbackTurnId: "turn-1",
    receivedAtMs: 900,
  });

  scheduler.notifyCurrentTurnChanged("turn-2");

  assert.equal(started.length, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].messageId, "msg-dropped");
  assert.equal(failed[0].turnId, "turn-1");
  assert.equal(failed[0].startReason, "current_turn_changed");
}

function testSameMessageIdDifferentTurnsStartByCompositeIdentity(): void {
  resetTimers();
  const session = buildSession("completed");
  const started: StartPayloadContext[] = [];
  const scheduler = createMotionRuntimeScheduler(
    {
      getCurrentTurnId: () => "turn-1",
      sessionStore: {
        getActiveSession: () => session,
        getSessionByTurnId: (turnId) => ({
          ...session,
          id: `turn:${turnId ?? ""}`,
          turnId,
          segmentOrder: ["shared-msg"],
          segments: new Map([
            [
              "shared-msg",
              {
                messageId: "shared-msg",
                turnId,
                audio: {
                  released: true,
                  started: false,
                  startedAtMs: null,
                  durationMs: null,
                  terminal: "idle",
                },
              },
            ],
          ]),
        }),
      },
    },
    {
      onPendingStateChanged: () => {},
      onPendingStatus: () => {},
      onStartPayload: (_payload, context) => {
        started.push(context);
        return true;
      },
    },
  );

  scheduler.queueInboundPayload(buildPayload(), {
    messageId: "shared-msg",
    turnId: "turn-a",
    playbackTurnId: "turn-a",
    receivedAtMs: 900,
  });
  scheduler.queueInboundPayload(buildPayload(), {
    messageId: "shared-msg",
    turnId: "turn-b",
    playbackTurnId: "turn-b",
    receivedAtMs: 910,
  });

  scheduler.handlePlaybackTimelineStarted(buildTimelineSnapshot({
    turnId: "turn-b",
    messageId: "shared-msg",
  }));

  assert.equal(started.length, 1);
  assert.equal(started[0].turnId, "turn-b");

  scheduler.handlePlaybackTimelineStarted(buildTimelineSnapshot({
    turnId: "turn-a",
    messageId: "shared-msg",
  }));

  assert.equal(started.length, 2);
  assert.equal(started[1].turnId, "turn-a");
}

function testCompositeIdentityDoesNotCollideOnDelimiterText(): void {
  resetTimers();
  const session = buildSession("completed");
  const started: StartPayloadContext[] = [];
  const scheduler = createMotionRuntimeScheduler(
    {
      getCurrentTurnId: () => "a::b",
      sessionStore: {
        getActiveSession: () => session,
        getSessionByTurnId: () => session,
      },
    },
    {
      onPendingStateChanged: () => {},
      onPendingStatus: () => {},
      onStartPayload: (_payload, context) => {
        started.push(context);
        return true;
      },
    },
  );

  scheduler.queueInboundPayload(buildPayload(), {
    turnId: "a",
    playbackTurnId: "a",
    messageId: "b::c",
    receivedAtMs: 900,
  });
  scheduler.queueInboundPayload(buildPayload(), {
    turnId: "a::b",
    playbackTurnId: "a::b",
    messageId: "c",
    receivedAtMs: 910,
  });

  assert.equal(scheduler.handlePlaybackTimelineStarted(buildTimelineSnapshot({
    turnId: "a::b",
    messageId: "c",
  })), true);
  assert.equal(scheduler.handlePlaybackTimelineStarted(buildTimelineSnapshot({
    turnId: "a",
    messageId: "b::c",
  })), true);
  assert.deepEqual(started.map((item) => [item.turnId, item.messageId]), [
    ["a::b", "c"],
    ["a", "b::c"],
  ]);
}

function testPlaybackTimelineRequiresMatchingTurnWhenMessageIdIsShared(): void {
  resetTimers();
  const activeSession: ModelEnginePlaybackSession = {
    id: "turn:turn-active",
    turnId: "turn-active",
    segmentOrder: ["shared-msg"],
    segments: new Map([
      [
        "shared-msg",
        {
          messageId: "shared-msg",
          turnId: "turn-active",
          audio: {
            released: true,
            started: true,
            startedAtMs: 800,
            durationMs: 2000,
            terminal: "idle",
          },
        },
      ],
    ]),
  };
  const targetSession: ModelEnginePlaybackSession = {
    id: "turn:turn-target",
    turnId: "turn-target",
    segmentOrder: ["shared-msg"],
    segments: new Map([
      [
        "shared-msg",
        {
          messageId: "shared-msg",
          turnId: "turn-target",
          audio: {
            released: true,
            started: false,
            startedAtMs: null,
            durationMs: null,
            terminal: "idle",
          },
        },
      ],
    ]),
  };
  const started: StartPayloadContext[] = [];
  const scheduler = createMotionRuntimeScheduler(
    {
      getCurrentTurnId: () => "turn-target",
      sessionStore: {
        getActiveSession: () => activeSession,
        getSessionByTurnId: (turnId) =>
          turnId === "turn-target" ? targetSession : activeSession,
      },
    },
    {
      onPendingStateChanged: () => {},
      onPendingStatus: () => {},
      onStartPayload: (_payload, context) => {
        started.push(context);
        return true;
      },
    },
  );

  scheduler.queueInboundPayload(buildPayload(), {
    messageId: "shared-msg",
    turnId: "turn-target",
    playbackTurnId: "turn-target",
    receivedAtMs: 900,
  });

  assert.equal(started.length, 0);

  assert.equal(
    scheduler.handlePlaybackTimelineStarted(buildTimelineSnapshot({
      turnId: "turn-active",
      messageId: "shared-msg",
    })),
    false,
  );
  assert.equal(started.length, 0);

  assert.equal(
    scheduler.handlePlaybackTimelineStarted(buildTimelineSnapshot({
      turnId: "turn-target",
      messageId: "shared-msg",
    })),
    true,
  );
  assert.equal(started.length, 1);
  assert.equal(started[0].turnId, "turn-target");
}

function testTimelineStartReturnsFalseWithoutQueuedMotion(): void {
  resetTimers();
  const { scheduler, started } = createHarness(buildSession());

  assert.equal(
    scheduler.handlePlaybackTimelineStarted(buildTimelineSnapshot()),
    false,
  );
  assert.equal(started.length, 0);
}

function testCurvePayloadRequiresTimelineBeforeInitialTimeout(): void {
  resetTimers();
  const session = buildSession();
  setAudioWaiting(session);
  const { scheduler, started, failed } = createHarness(session);

  scheduler.queueInboundPayload(buildCurvePayload(), {
    messageId: "msg-1",
    turnId: "turn-1",
    playbackTurnId: "turn-1",
    receivedAtMs: 900,
  });

  const timer = timers.values().next().value;
  assert.ok(timer);
  timer();

  assert.equal(started.length, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].startReason, "playback_timeline_missing_before_curve_motion_start");
}

function testPlaybackTimelineStartRefreshesPendingPlaybackTimeline(): void {
  resetTimers();
  const session = buildSession();
  setAudioWaiting(session);
  const { scheduler, started } = createHarness(session);
  const staleTimeline = buildTimelineSnapshot({
    timelineId: "stale",
    phase: "preparing",
    currentTimeMs: 0,
    durationMs: 1000,
  });
  const freshTimeline = buildTimelineSnapshot({
    timelineId: "fresh",
    phase: "playing",
    currentTimeMs: 360,
    durationMs: 2200,
  });

  scheduler.queueInboundPayload(buildPayload(), {
    messageId: "msg-1",
    turnId: "turn-1",
    playbackTurnId: "turn-1",
    receivedAtMs: 900,
    playbackTimeline: staleTimeline,
  });

  assert.equal(
    scheduler.handlePlaybackTimelineStarted(freshTimeline),
    true,
  );
  assert.equal(started.length, 1);
  assert.equal(started[0].playbackTimeline?.timelineId, "fresh");
  assert.equal(started[0].playbackTimeline?.durationMs, 2200);
  assert.equal(started[0].startReason, "playback_timeline_started");
}

function testUnavailablePlaybackTimelineFailsPendingMotion(): void {
  resetTimers();
  const session = buildSession();
  setAudioWaiting(session);
  const { scheduler, started, failed } = createHarness(session);

  scheduler.queueInboundPayload(buildCurvePayload(), {
    messageId: "msg-1",
    turnId: "turn-1",
    playbackTurnId: "turn-1",
    receivedAtMs: 900,
  });

  scheduler.handlePlaybackTimelineStarted(buildTimelineSnapshot({
    clockSource: "audio_unavailable",
  }));

  assert.equal(started.length, 0);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].startReason, "playback_timeline_audio_unavailable_before_motion_start");
}

function run(): void {
  testQueuedPayloadFailsWhenTimelineDoesNotArrive();
  testQueuedPayloadFailureRetainsPreparingTimelineOwnership();
  testDroppedPendingPayloadReportsStartFailure();
  testSameMessageIdDifferentTurnsStartByCompositeIdentity();
  testCompositeIdentityDoesNotCollideOnDelimiterText();
  testPlaybackTimelineRequiresMatchingTurnWhenMessageIdIsShared();
  testTimelineStartReturnsFalseWithoutQueuedMotion();
  testCurvePayloadRequiresTimelineBeforeInitialTimeout();
  testPlaybackTimelineStartRefreshesPendingPlaybackTimeline();
  testUnavailablePlaybackTimelineFailsPendingMotion();
  console.log("motionRuntimeScheduler tests passed");
}

run();
