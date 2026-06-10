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
  const { scheduler } = createHarness(buildSession("completed"));

  assert.equal(scheduler.isSpeechActiveForPayload("msg-1", "turn-1", "turn-1"), false);
  assert.equal(scheduler.resolveMotionTargetDurationMs("msg-1", "turn-1", "turn-1"), null);
}

function testQueuedPlaybackTurnIdIsNormalized(): void {
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

function run(): void {
  testEndedAudioDoesNotCountAsSpeechActiveOrDurationTarget();
  testQueuedPlaybackTurnIdIsNormalized();
  testDroppedPendingPayloadReportsStartFailure();
  console.log("motionRuntimeScheduler tests passed");
}

run();
