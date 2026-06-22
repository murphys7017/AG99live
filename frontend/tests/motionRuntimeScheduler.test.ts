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

function testEndedAudioDoesNotCountAsSpeechActiveOrDurationTarget(): void {
  resetTimers();
  const { scheduler } = createHarness(buildSession("completed"));

  assert.equal(scheduler.isSpeechActiveForPayload("msg-1", "turn-1", "turn-1"), false);
  assert.equal(scheduler.resolveMotionTargetDurationMs("msg-1", "turn-1", "turn-1"), null);
}

function testQueuedPlaybackTurnIdIsNormalized(): void {
  resetTimers();
  const { scheduler, started } = createHarness(buildSession("completed"));

  scheduler.queueInboundPayload(buildPayload(), {
    messageId: "msg-queued",
    turnId: " turn-1 ",
    playbackTurnId: " turn-1 ",
    receivedAtMs: 900,
  });

  const timer = timers.values().next().value;
  assert.ok(timer);
  timer();

  assert.equal(started.length, 1);
  assert.equal(started[0].turnId, "turn-1");
  assert.equal(started[0].playbackTurnId, "turn-1");
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

  scheduler.notifyAudioPlaybackStarted("turn-b", "shared-msg");

  assert.equal(started.length, 1);
  assert.equal(started[0].turnId, "turn-b");

  scheduler.notifyAudioPlaybackStarted("turn-a", "shared-msg");

  assert.equal(started.length, 2);
  assert.equal(started[1].turnId, "turn-a");
}

function testActiveAudioLookupRequiresMatchingTurnWhenMessageIdIsShared(): void {
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
    scheduler.notifyAudioPlaybackStarted("turn-active", "shared-msg"),
    false,
  );
  assert.equal(started.length, 0);

  assert.equal(
    scheduler.notifyAudioPlaybackStarted("turn-target", "shared-msg"),
    true,
  );
  assert.equal(started.length, 1);
  assert.equal(started[0].turnId, "turn-target");
}

function testAudioStartReturnsFalseWithoutQueuedMotion(): void {
  resetTimers();
  const { scheduler, started } = createHarness(buildSession());

  assert.equal(
    scheduler.notifyAudioPlaybackStarted("turn-1", "msg-1"),
    false,
  );
  assert.equal(started.length, 0);
}

function run(): void {
  testEndedAudioDoesNotCountAsSpeechActiveOrDurationTarget();
  testQueuedPlaybackTurnIdIsNormalized();
  testDroppedPendingPayloadReportsStartFailure();
  testSameMessageIdDifferentTurnsStartByCompositeIdentity();
  testActiveAudioLookupRequiresMatchingTurnWhenMessageIdIsShared();
  testAudioStartReturnsFalseWithoutQueuedMotion();
  console.log("motionRuntimeScheduler tests passed");
}

run();
