// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { effectScope, nextTick } from "vue";
import { useTurnPlaybackSessionStore } from "../src/turn-playback/useTurnPlaybackSessionStore.js";
import { useTurnPlaybackOrchestrator } from "../src/turn-playback/useTurnPlaybackOrchestrator.js";
import type {
  InboundPayloadContext,
  NormalizedMotionPayload,
} from "../src/model-engine/contracts.js";
import type { MotionPlaybackClockContext } from "../src/model-engine/runtime/playbackClock.js";
import { createModelEngineMotionTimelineSink } from "../src/playback-integrations/modelEngineMotionSink.js";
import {
  createPlaybackTimelineRuntime as createStrictPlaybackTimelineRuntime,
} from "../src/playback-timeline/playbackTimelineRuntime.js";
import type {
  PlaybackTimelineSegmentExecutionPorts,
} from "../src/playback-timeline/segmentJob.js";
import type { PlaybackTimelineSnapshot } from "../src/playback-timeline/contracts.js";
import type { PerformanceCurveHint } from "../src/types/protocol.js";

function createPlaybackTimelineRuntime(
  deps: Omit<
    Parameters<typeof createStrictPlaybackTimelineRuntime>[0],
    "segmentExecution"
  >,
) {
  let ports: PlaybackTimelineSegmentExecutionPorts = {
    session: {
      markTextReleased: () => {},
      markAudioReleased: () => {},
      markMotionReleased: () => {},
      markMotionFailed: () => {},
      markPhase: () => true,
    },
    textSink: { releaseAssistantTextForPlayback: () => true },
    audioSink: { releaseAudioForPlayback: () => true },
    motionSink: { start: () => true, interrupt: () => {} },
  };
  const runtime = createStrictPlaybackTimelineRuntime({
    ...deps,
    segmentExecution: {
      session: {
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

const motionPayload: NormalizedMotionPayload = {
  kind: "semantic_intent",
  intent: {
    schema_version: "engine.motion_intent.v3",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    emotion_label: "happy",
    axes: {},
  },
};

const curveHint: PerformanceCurveHint = {
  schema_version: "ag99.performance_curve_hint.v1",
  curve_family: "quick_in_hold_soft_out",
  entry: "quick",
  hold: "steady",
  exit: "soft",
  emphasis: "early",
  energy: "medium",
};

const matchingTimelineSnapshot: PlaybackTimelineSnapshot = {
  timelineId: "timeline-1",
  turnId: "turn-timeline",
  messageId: "msg-timeline",
  phase: "playing",
  clockSource: "audio",
  startedAtMs: 100,
  currentTimeMs: 0,
  durationMs: 1800,
  playbackRate: 1,
  sinks: [
    {
      id: "audio",
      required: true,
      terminal: "started",
    },
    {
      id: "motion",
      required: true,
      terminal: "idle",
    },
  ],
};

const matchingMotionOnlyTimelineSnapshot: PlaybackTimelineSnapshot = {
  timelineId: "timeline-motion-only",
  turnId: "turn-motion-only",
  messageId: "msg-motion-only",
  phase: "preparing",
  clockSource: "synthetic",
  startedAtMs: null,
  currentTimeMs: 0,
  durationMs: null,
  playbackRate: 1,
  sinks: [
    {
      id: "motion",
      required: true,
      terminal: "idle",
    },
  ],
};

const matchingPreparingAudioTimelineSnapshot: PlaybackTimelineSnapshot = {
  ...matchingTimelineSnapshot,
  timelineId: "timeline-preparing-audio",
  phase: "preparing",
  startedAtMs: null,
  currentTimeMs: 0,
  durationMs: null,
  sinks: matchingTimelineSnapshot.sinks.map((sink) => ({
    ...sink,
    terminal: "idle",
  })),
};

function createMissingMotionTimelineWiring() {
  return {
    getPlaybackTimelineSnapshotForSegment: () => null,
  };
}
function createHarness(options: {
  motionAccepted?: boolean;
  audioTimelineAfterRelease?: PlaybackTimelineSnapshot | null;
  installFakeTimers?: boolean;
} = {}) {
  const sessionStore = useTurnPlaybackSessionStore();
  const released: string[] = [];
  const motionSinkStarts: string[] = [];
  const motionPayloads: NormalizedMotionPayload[] = [];
  const motionContexts: Array<{
    messageId: string;
    turnId: string | null;
    playbackClock?: MotionPlaybackClockContext | null;
  }> = [];
  const turnChanges: Array<string | null> = [];
  const logs: Array<{ message: string; details: Record<string, unknown> }> = [];
  const scope = effectScope();
  const originalConsoleInfo = console.info;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const fakeTimers = new Map<number, () => void>();
  let nextFakeTimerId = 1;
  if (options.installFakeTimers) {
    window.setTimeout = ((fn: TimerHandler, _timeout?: number) => {
      const id = nextFakeTimerId++;
      fakeTimers.set(id, () => {
        if (typeof fn === "function") {
          fn();
        }
      });
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((timer?: number) => {
      if (typeof timer === "number") {
        fakeTimers.delete(timer);
      }
    }) as typeof window.clearTimeout;
  }
  console.info = (...args: unknown[]) => {
    if (
      typeof args[0] === "string"
      && args[0].startsWith("[TurnPlaybackOrchestrator]")
      && typeof args[1] === "object"
      && args[1] !== null
    ) {
      logs.push({
        message: args[0],
        details: args[1] as Record<string, unknown>,
      });
    }
    originalConsoleInfo(...args);
  };

  const adapter = {
    releaseAssistantTextForPlayback(
      messageId: string,
      turnId: string | null,
    ): boolean {
      released.push(`text:${messageId}:${turnId ?? ""}`);
      return true;
    },
    releaseAudioForPlayback(
      messageId: string,
      turnId: string | null,
    ): boolean {
      released.push(`audio:${messageId}:${turnId ?? ""}`);
      return true;
    },
  };

  const timelineRuntime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
    motionSession: {
      markMotionStarted: sessionStore.markMotionStarted,
      markMotionCompleted: sessionStore.markMotionCompleted,
      markMotionFailed: sessionStore.markMotionFailed,
    },
  });

  const modelEngine = {
    ingestNormalizedPayload(
      payload: NormalizedMotionPayload,
      context: {
        messageId: string;
        turnId: string | null;
        playbackClock?: MotionPlaybackClockContext | null;
      },
    ): boolean {
      motionPayloads.push(payload);
      motionContexts.push(context);
      const accepted = options.motionAccepted ?? true;
      if (!accepted) {
        timelineRuntime.markMotionTimelineTerminal(
          context.turnId,
          context.messageId,
          "failed",
          "motion_payload_rejected",
        );
      }
      return accepted;
    },
    notifyCurrentTurnChanged(turnId: string | null): void {
      turnChanges.push(turnId);
    },
    interruptPlaybackSegment: () => {},
  };
  const motionTimelineSink = createModelEngineMotionTimelineSink({
    motionEngine: modelEngine,
    getPlaybackTimelineSnapshotForSegment: (turnId, messageId) => {
      if (options.audioTimelineAfterRelease !== undefined) {
        const snapshot = options.audioTimelineAfterRelease;
        if (
          snapshot
          && snapshot.turnId === turnId
          && snapshot.messageId === messageId
        ) {
          return snapshot;
        }
        return null;
      }
      return timelineRuntime.getTimelineSnapshotForSegment(turnId, messageId);
    },
    markMotionTimelineTerminal: timelineRuntime.markMotionTimelineTerminal,
  });

  const recordingMotionSink = {
    interrupt(turnId: string | null, messageId: string, reason: string) {
      motionTimelineSink.interrupt(turnId, messageId, reason);
    },
    start(
      payload: NormalizedMotionPayload,
      context: Parameters<typeof motionTimelineSink.start>[1],
    ) {
      motionSinkStarts.push(`motion:${context.messageId}:${context.turnId ?? ""}`);
      return motionTimelineSink.start(payload, context);
    },
  };

  timelineRuntime.configureSegmentExecution({
    session: {
      markTextReleased: sessionStore.markTextReleased,
      markAudioReleased: sessionStore.markAudioReleased,
      markMotionReleased: sessionStore.markMotionReleased,
      markMotionFailed: sessionStore.markMotionFailed,
      markPhase: sessionStore.markPhase,
    },
    textSink: adapter,
    audioSink: adapter,
    motionSink: recordingMotionSink,
  });

  scope.run(() => {
    useTurnPlaybackOrchestrator({
      sessionStore,
      motionPayload: {
        notifyCurrentTurnChanged: motionTimelineSink.notifyCurrentTurnChanged,
      },
      timelineRuntime,
    });
  });

  return {
    sessionStore,
    released,
    motionSinkStarts,
    motionPayloads,
    motionContexts,
    turnChanges,
    logs,
    fakeTimers,
    runFakeTimer: (timerId: number) => {
      const fn = fakeTimers.get(timerId);
      assert.ok(fn, `timer ${timerId} should exist`);
      fakeTimers.delete(timerId);
      fn();
    },
    flush: () => nextTick(),
    stop: () => {
      scope.stop();
      console.info = originalConsoleInfo;
      if (options.installFakeTimers) {
        window.setTimeout = originalSetTimeout;
        window.clearTimeout = originalClearTimeout;
      }
    },
  };
}

async function testSegmentsReleaseSequentiallyWithinTurn(): Promise<void> {
  const h = createHarness();
  h.sessionStore.setActiveSession("turn-1");
  h.sessionStore.markTurnStarted("turn-1");

  h.sessionStore.markTextReceived("turn-1", "A", "msg-a");
  h.sessionStore.markAudioReceived("turn-1", "http://localhost/a.wav", "msg-a");
  h.sessionStore.markMotionReceived("turn-1", motionPayload, "msg-a");

  h.sessionStore.markTextReceived("turn-1", "B", "msg-b");
  h.sessionStore.markAudioReceived("turn-1", "http://localhost/b.wav", "msg-b");
  h.sessionStore.markMotionReceived("turn-1", motionPayload, "msg-b");

  await h.flush();
  await h.flush();

  assert.deepEqual(h.released, [
    "text:msg-a:turn-1",
    "audio:msg-a:turn-1",
  ]);
  assert.deepEqual(h.motionSinkStarts, [
    "motion:msg-a:turn-1",
  ]);

  h.sessionStore.markTextDelivered("turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("turn-1", "completed", "msg-a");
  h.sessionStore.markMotionCompleted("turn-1", "msg-a");

  await h.flush();
  await h.flush();

  assert.deepEqual(h.released, [
    "text:msg-a:turn-1",
    "audio:msg-a:turn-1",
    "text:msg-b:turn-1",
    "audio:msg-b:turn-1",
  ]);
  assert.deepEqual(h.motionSinkStarts, [
    "motion:msg-a:turn-1",
    "motion:msg-b:turn-1",
  ]);
  h.stop();
}

async function testTextAndMotionReleaseWhenAudioIsAbsent(): Promise<void> {
  const h = createHarness();
  h.sessionStore.setActiveSession("turn-text-motion");
  h.sessionStore.markTurnStarted("turn-text-motion");

  h.sessionStore.markTextReceived("turn-text-motion", "hello", "msg-text-motion");
  h.sessionStore.markMotionReceived("turn-text-motion", motionPayload, "msg-text-motion");
  h.sessionStore.markSynthFinished("turn-text-motion");
  h.sessionStore.markAudioTerminal(
    "turn-text-motion",
    "absent",
    "msg-text-motion",
    "synth_finished_without_audio_playback",
  );

  await h.flush();
  await h.flush();

  assert.deepEqual(h.released, [
    "text:msg-text-motion:turn-text-motion",
  ]);
  assert.deepEqual(h.motionSinkStarts, [
    "motion:msg-text-motion:turn-text-motion",
  ]);
  assert.equal(
    h.logs.some((item) =>
      item.message.includes("motion released")
      && String(item.details.reason || "").startsWith("late_motion_after_")
    ),
    false,
  );
  h.stop();
}

async function testAudioCaptionOnlySegmentDoesNotReleaseVisibleText(): Promise<void> {
  const h = createHarness();
  h.sessionStore.setActiveSession("turn-audio-caption");
  h.sessionStore.markTurnStarted("turn-audio-caption");

  h.sessionStore.markAudioReceived(
    "turn-audio-caption",
    "http://localhost/caption.wav",
    "msg-audio-caption",
    "subtitle only",
  );
  h.sessionStore.markTextDelivered("turn-audio-caption", "msg-audio-caption");
  h.sessionStore.markMotionReceived("turn-audio-caption", motionPayload, "msg-audio-caption");

  await h.flush();
  await h.flush();

  assert.deepEqual(h.released, [
    "audio:msg-audio-caption:turn-audio-caption",
  ]);
  assert.deepEqual(h.motionSinkStarts, [
    "motion:msg-audio-caption:turn-audio-caption",
  ]);
  const segment = h.sessionStore
    .getSession("turn-audio-caption")
    ?.segments.get("msg-audio-caption");
  assert.equal(segment?.text.content, null);
  assert.equal(segment?.audio.captionText, "subtitle only");
  h.stop();
}

async function testVisibleTextArrivingAfterAudioCaptionIsReleasedOnce(): Promise<void> {
  const h = createHarness();
  h.sessionStore.setActiveSession("turn-late-visible-text");
  h.sessionStore.markTurnStarted("turn-late-visible-text");

  h.sessionStore.markAudioReceived(
    "turn-late-visible-text",
    "http://localhost/late-visible-text.wav",
    "msg-late-visible-text",
    "subtitle only",
  );
  h.sessionStore.markTextDelivered(
    "turn-late-visible-text",
    "msg-late-visible-text",
  );
  h.sessionStore.markMotionReceived(
    "turn-late-visible-text",
    motionPayload,
    "msg-late-visible-text",
  );

  await h.flush();
  await h.flush();

  assert.deepEqual(h.released, [
    "audio:msg-late-visible-text:turn-late-visible-text",
  ]);
  assert.deepEqual(h.motionSinkStarts, [
    "motion:msg-late-visible-text:turn-late-visible-text",
  ]);

  h.sessionStore.markTextReceived(
    "turn-late-visible-text",
    "visible reply",
    "msg-late-visible-text",
  );

  await h.flush();
  await h.flush();

  assert.deepEqual(h.released, [
    "audio:msg-late-visible-text:turn-late-visible-text",
    "text:msg-late-visible-text:turn-late-visible-text",
  ]);
  assert.deepEqual(h.motionSinkStarts, [
    "motion:msg-late-visible-text:turn-late-visible-text",
  ]);
  h.stop();
}

async function testMotionReleaseReceivesMatchingAudioTimeline(): Promise<void> {
  const h = createHarness({
    audioTimelineAfterRelease: matchingTimelineSnapshot,
  });
  h.sessionStore.setActiveSession("turn-timeline");
  h.sessionStore.markTurnStarted("turn-timeline");

  h.sessionStore.markTextReceived("turn-timeline", "hello", "msg-timeline");
  h.sessionStore.markAudioReceived(
    "turn-timeline",
    "http://localhost/timeline.wav",
    "msg-timeline",
  );
  h.sessionStore.markMotionReceived("turn-timeline", motionPayload, "msg-timeline");

  await h.flush();
  await h.flush();

  assert.deepEqual(h.released, [
    "text:msg-timeline:turn-timeline",
    "audio:msg-timeline:turn-timeline",
  ]);
  assert.deepEqual(h.motionSinkStarts, [
    "motion:msg-timeline:turn-timeline",
  ]);
  assert.equal(h.motionContexts.length, 1);
  assert.equal(
    h.motionContexts[0].playbackClock?.timelineId,
    "timeline-1",
  );
  assert.equal(
    h.motionContexts[0].playbackClock?.durationMs,
    1800,
  );
  h.stop();
}

async function testMotionReleaseRejectsMismatchedAudioTimeline(): Promise<void> {
  const h = createHarness({
    audioTimelineAfterRelease: {
      ...matchingTimelineSnapshot,
      turnId: "turn-other",
    },
  });
  h.sessionStore.setActiveSession("turn-timeline");
  h.sessionStore.markTurnStarted("turn-timeline");

  h.sessionStore.markTextReceived("turn-timeline", "hello", "msg-timeline");
  h.sessionStore.markAudioReceived(
    "turn-timeline",
    "http://localhost/timeline.wav",
    "msg-timeline",
  );
  h.sessionStore.markMotionReceived("turn-timeline", motionPayload, "msg-timeline");

  await h.flush();
  await h.flush();

  assert.deepEqual(h.motionSinkStarts, [
    "motion:msg-timeline:turn-timeline",
  ]);
  assert.equal(h.motionContexts.length, 0);
  h.stop();
}

async function testRejectedMotionReleaseMarksSegmentFailed(): Promise<void> {
  const h = createHarness({ motionAccepted: false });
  h.sessionStore.setActiveSession("turn-motion-rejected");
  h.sessionStore.markTurnStarted("turn-motion-rejected");

  h.sessionStore.markTextReceived("turn-motion-rejected", "hello", "msg-motion-rejected");
  h.sessionStore.markMotionReceived("turn-motion-rejected", motionPayload, "msg-motion-rejected");
  h.sessionStore.markSynthFinished("turn-motion-rejected");
  h.sessionStore.markAudioTerminal(
    "turn-motion-rejected",
    "absent",
    "msg-motion-rejected",
    "synth_finished_without_audio_playback",
  );

  await h.flush();
  await h.flush();

  const segment = h.sessionStore
    .getSession("turn-motion-rejected")
    ?.segments.get("msg-motion-rejected");
  assert.equal(segment?.motion.released, true);
  assert.equal(segment?.motion.absent, false);
  assert.equal(segment?.motion.completed, false);
  assert.equal(segment?.motion.failed, true);
  assert.equal(segment?.motion.reason, "motion_payload_rejected");
  assert.deepEqual(h.motionSinkStarts, [
    "motion:msg-motion-rejected:turn-motion-rejected",
  ]);
  h.stop();
}

async function testMotionWithoutReceivedAtMarksSegmentFailed(): Promise<void> {
  const h = createHarness();
  h.sessionStore.setActiveSession("turn-motion-missing-time");
  h.sessionStore.markTurnStarted("turn-motion-missing-time");

  h.sessionStore.markTextReceived("turn-motion-missing-time", "hello", "msg-motion-missing-time");
  h.sessionStore.markMotionReceived(
    "turn-motion-missing-time",
    motionPayload,
    "msg-motion-missing-time",
  );
  const segment = h.sessionStore
    .getSession("turn-motion-missing-time")
    ?.segments.get("msg-motion-missing-time");
  if (!segment) {
    throw new Error("expected test segment");
  }
  segment.motion.receivedAtMs = null;
  h.sessionStore.markSynthFinished("turn-motion-missing-time");
  h.sessionStore.markAudioTerminal(
    "turn-motion-missing-time",
    "absent",
    "msg-motion-missing-time",
    "synth_finished_without_audio_playback",
  );

  await h.flush();
  await h.flush();

  assert.equal(segment.motion.released, true);
  assert.equal(segment.motion.failed, true);
  assert.equal(segment.motion.reason, "motion_received_at_missing");
  assert.deepEqual(h.released, [
    "text:msg-motion-missing-time:turn-motion-missing-time",
  ]);
  h.stop();
}

async function testPerformanceCurveHintIsMergedBeforeMotionRelease(): Promise<void> {
  const h = createHarness();
  h.sessionStore.setActiveSession("turn-curve");
  h.sessionStore.markTurnStarted("turn-curve");
  if (motionPayload.kind !== "semantic_intent") {
    throw new Error("expected semantic_intent fixture");
  }
  const payloadWithCurve: NormalizedMotionPayload = {
    kind: "semantic_intent",
    intent: {
      ...motionPayload.intent,
      performance_curve_hint: curveHint,
    },
  };

  h.sessionStore.markTextReceived("turn-curve", "hello", "msg-curve");
  h.sessionStore.markMotionReceived("turn-curve", payloadWithCurve, "msg-curve");
  h.sessionStore.markSynthFinished("turn-curve");
  h.sessionStore.markAudioTerminal(
    "turn-curve",
    "absent",
    "msg-curve",
    "synth_finished_without_audio_playback",
  );

  await h.flush();
  await h.flush();

  assert.equal(h.motionPayloads.length, 1);
  const releasedPayload = h.motionPayloads[0];
  assert.equal(releasedPayload.kind, "semantic_intent");
  if (releasedPayload.kind !== "semantic_intent") {
    throw new Error("expected semantic_intent payload");
  }
  assert.deepEqual(releasedPayload.intent.performance_curve_hint, curveHint);
  const storedPayload = h.sessionStore
    .getSession("turn-curve")
    ?.segments.get("msg-curve")
    ?.motion.payload;
  assert.equal(storedPayload?.kind, "semantic_intent");
  if (storedPayload?.kind !== "semantic_intent") {
    throw new Error("expected stored semantic_intent payload");
  }
  assert.deepEqual(storedPayload.intent.performance_curve_hint, curveHint);
  h.stop();
}

function testMotionTimelineSinkLeavesRejectedTerminalOwnershipToEngine(): void {
  const terminals: string[] = [];
  const contexts: InboundPayloadContext[] = [];
  const sink = createModelEngineMotionTimelineSink({
    motionEngine: {
      ingestNormalizedPayload: (_payload, context) => {
        contexts.push(context);
        return false;
      },
      notifyCurrentTurnChanged: () => {},
      interruptPlaybackSegment: () => {},
    },
    getPlaybackTimelineSnapshotForSegment: () => matchingTimelineSnapshot,
    markMotionTimelineTerminal: (turnId, messageId, terminal, reason) => {
      terminals.push(`${turnId ?? ""}:${messageId}:${terminal}:${reason}`);
    },
  });

  const accepted = sink.start(motionPayload, {
    messageId: "msg-timeline",
    turnId: "turn-timeline",
    receivedAtMs: 100,
  });

  assert.equal(accepted, false);
  assert.equal(contexts[0].playbackClock?.timelineId, "timeline-1");
  assert.deepEqual(terminals, []);
}

function testMotionTimelineSinkUsesPreparedSyntheticTimelineWhenAudioAbsent(): void {
  const contexts: InboundPayloadContext[] = [];
  const sink = createModelEngineMotionTimelineSink({
    motionEngine: {
      ingestNormalizedPayload: (_payload, context) => {
        contexts.push(context);
        return true;
      },
      notifyCurrentTurnChanged: () => {},
      interruptPlaybackSegment: () => {},
    },
    getPlaybackTimelineSnapshotForSegment: () => matchingMotionOnlyTimelineSnapshot,
    markMotionTimelineTerminal: () => {},
  });

  const accepted = sink.start(motionPayload, {
    messageId: "msg-motion-only",
    turnId: "turn-motion-only",
    receivedAtMs: 100,
    timelineMode: "motion_only",
  });

  assert.equal(accepted, true);
  assert.equal(contexts[0].playbackClock?.timelineId, "timeline-motion-only");
  assert.equal(contexts[0].playbackClock?.source, "synthetic");
}

function testMotionTimelineSinkRetainsPreparingAudioTimelineOwnership(): void {
  const contexts: InboundPayloadContext[] = [];
  const sink = createModelEngineMotionTimelineSink({
    motionEngine: {
      ingestNormalizedPayload: (_payload, context) => {
        contexts.push(context);
        return true;
      },
      notifyCurrentTurnChanged: () => {},
      interruptPlaybackSegment: () => {},
    },
    getPlaybackTimelineSnapshotForSegment: () => matchingPreparingAudioTimelineSnapshot,
    markMotionTimelineTerminal: () => {},
  });

  const accepted = sink.start(motionPayload, {
    messageId: "msg-timeline",
    turnId: "turn-timeline",
    receivedAtMs: 100,
  });

  assert.equal(accepted, true);
  assert.equal(
    contexts[0].playbackClock?.timelineId,
    "timeline-preparing-audio",
  );
  assert.equal(contexts[0].playbackClock?.phase, "preparing");
}

function testMotionTimelineSinkRejectsMissingAudioTimeline(): void {
  const contexts: InboundPayloadContext[] = [];
  const terminals: string[] = [];
  const sink = createModelEngineMotionTimelineSink({
    motionEngine: {
      ingestNormalizedPayload: (_payload, context) => {
        contexts.push(context);
        return true;
      },
      notifyCurrentTurnChanged: () => {},
      interruptPlaybackSegment: () => {},
    },
    getPlaybackTimelineSnapshotForSegment:
      createMissingMotionTimelineWiring().getPlaybackTimelineSnapshotForSegment,
    markMotionTimelineTerminal: (turnId, messageId, terminal, reason) => {
      terminals.push(`${turnId ?? ""}:${messageId}:${terminal}:${reason}`);
    },
  });

  const accepted = sink.start(motionPayload, {
    messageId: "msg-motion-only",
    turnId: "turn-motion-only",
    receivedAtMs: 100,
  });

  assert.equal(accepted, false);
  assert.equal(contexts.length, 0);
  assert.deepEqual(terminals, [
    "turn-motion-only:msg-motion-only:failed:motion_timeline_unavailable",
  ]);
}

function testMotionTimelineSinkRejectsMissingMotionOnlyTimeline(): void {
  const contexts: InboundPayloadContext[] = [];
  const terminals: string[] = [];
  const sink = createModelEngineMotionTimelineSink({
    motionEngine: {
      ingestNormalizedPayload: (_payload, context) => {
        contexts.push(context);
        return true;
      },
      notifyCurrentTurnChanged: () => {},
      interruptPlaybackSegment: () => {},
    },
    getPlaybackTimelineSnapshotForSegment:
      createMissingMotionTimelineWiring().getPlaybackTimelineSnapshotForSegment,
    markMotionTimelineTerminal: (turnId, messageId, terminal, reason) => {
      terminals.push(`${turnId ?? ""}:${messageId}:${terminal}:${reason}`);
    },
  });

  const accepted = sink.start(motionPayload, {
    messageId: "msg-motion-only",
    turnId: "turn-motion-only",
    receivedAtMs: 100,
    timelineMode: "motion_only",
  });

  assert.equal(accepted, false);
  assert.equal(contexts.length, 0);
  assert.deepEqual(terminals, [
    "turn-motion-only:msg-motion-only:failed:motion_only_timeline_unavailable",
  ]);
}

function testMotionTimelineSinkUsesSegmentScopedTimelineLookup(): void {
  const segmentTimelineLookupCalls: string[] = [];
  const contexts: InboundPayloadContext[] = [];
  const sink = createModelEngineMotionTimelineSink({
    motionEngine: {
      ingestNormalizedPayload: (_payload, context) => {
        contexts.push(context);
        return true;
      },
      notifyCurrentTurnChanged: () => {},
      interruptPlaybackSegment: () => {},
    },
    getPlaybackTimelineSnapshotForSegment: (turnId, messageId) => {
      segmentTimelineLookupCalls.push(`${turnId ?? ""}:${messageId}`);
      return matchingTimelineSnapshot;
    },
    markMotionTimelineTerminal: () => {},
  });

  const accepted = sink.start(motionPayload, {
    messageId: "msg-timeline",
    turnId: "turn-timeline",
    receivedAtMs: 100,
  });

  assert.equal(accepted, true);
  assert.deepEqual(segmentTimelineLookupCalls, [
    "turn-timeline:msg-timeline",
  ]);
  assert.equal(contexts[0].playbackClock?.timelineId, "timeline-1");
}

function createRuntimeWithSegmentExecutionPorts(
  ports: PlaybackTimelineSegmentExecutionPorts<NormalizedMotionPayload>,
) {
  const runtime = createPlaybackTimelineRuntime({
    getAudioClock: () => null,
  });
  runtime.configureSegmentExecution(ports);
  return runtime;
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

function testPlaybackTimelineRuntimeRejectsInvalidMotionTimestamp(): void {
  const sessionStore = useTurnPlaybackSessionStore();
  sessionStore.setActiveSession("turn-invalid-motion-time");
  sessionStore.markTurnStarted("turn-invalid-motion-time");
  sessionStore.markTextReceived(
    "turn-invalid-motion-time",
    "hello",
    "msg-invalid-motion-time",
  );
  sessionStore.markMotionReceived(
    "turn-invalid-motion-time",
    motionPayload,
    "msg-invalid-motion-time",
  );

  const runtime = createRuntimeWithSegmentExecutionPorts({
    session: {
      markTextReleased: sessionStore.markTextReleased,
      markAudioReleased: sessionStore.markAudioReleased,
      markMotionReleased: sessionStore.markMotionReleased,
      markMotionFailed: sessionStore.markMotionFailed,
      markPhase: sessionStore.markPhase,
    },
    textSink: {
      releaseAssistantTextForPlayback: () => true,
    },
    audioSink: {
      releaseAudioForPlayback: () => true,
    },
    motionSink: {
      start: () => true,
      interrupt: () => {},
    },
  });

  assert.throws(
    () => runtime.startSegmentJob({
      messageId: "msg-invalid-motion-time",
      turnId: "turn-invalid-motion-time",
      reason: "test",
      text: {
        release: false,
      },
      audio: {
        release: false,
        noAudioConfirmed: false,
      },
      motion: {
        payload: motionPayload,
        receivedAtMs: Number.NaN,
      },
    }),
    /valid receivedAtMs/,
  );
}

function testPlaybackTimelineRuntimeMarksMotionOnlyContext(): void {
  const events: string[] = [];
  const contexts: Array<{ timelineMode?: string }> = [];
  const runtime = createRuntimeWithSegmentExecutionPorts({
    session: {
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
        contexts.push({ timelineMode: context.timelineMode });
        return true;
      },
    },
  });

  const result = runtime.startSegmentJob({
    messageId: "msg-motion-only-job",
    turnId: "turn-motion-only-job",
    reason: "test",
    text: {
      release: false,
    },
    audio: {
      release: false,
      noAudioConfirmed: true,
    },
    motion: {
      payload: motionPayload,
      receivedAtMs: 123,
    },
  });

  assert.deepEqual(result, {
    releasedText: false,
    releasedAudio: false,
    releasedMotion: true,
  });
  assert.deepEqual(events, [
    "motion_released",
    "phase:playing",
  ]);
  assert.deepEqual(contexts, [
    { timelineMode: "motion_only" },
  ]);
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-motion-only-job", "msg-motion-only-job")
      ?.sinks.some((sink) => sink.id === "motion" && sink.required),
    true,
  );
}

function testPlaybackTimelineRuntimePreparesAudioMotionTimeline(): void {
  const events: string[] = [];
  const runtime = createRuntimeWithSegmentExecutionPorts({
    session: {
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
      releaseAudioForPlayback: () => {
        events.push("audio_sink");
        return true;
      },
    },
    motionSink: {
      interrupt: () => {},
      start: () => {
        events.push("motion_sink");
        return true;
      },
    },
  });

  const result = runtime.startSegmentJob({
    messageId: "msg-audio-motion-job",
    turnId: "turn-audio-motion-job",
    reason: "test",
    text: {
      release: false,
    },
    audio: {
      release: true,
      noAudioConfirmed: false,
    },
    motion: {
      payload: motionPayload,
      receivedAtMs: 123,
    },
  });

  assert.deepEqual(result, {
    releasedText: false,
    releasedAudio: true,
    releasedMotion: true,
  });
  assert.deepEqual(events, [
    "audio_sink",
    "audio_released",
    "motion_sink",
    "motion_released",
    "phase:playing",
  ]);
  const snapshot = runtime.getTimelineSnapshotForSegment(
    "turn-audio-motion-job",
    "msg-audio-motion-job",
  );
  assert.equal(snapshot?.sinks.some((sink) => sink.id === "audio" && sink.required), true);
  assert.equal(snapshot?.sinks.some((sink) => sink.id === "motion" && sink.required), true);
}


function testPlaybackTimelineRuntimeDoesNotReleaseMotionWhenAudioReleaseFails(): void {
  const events: string[] = [];
  const runtime = createRuntimeWithSegmentExecutionPorts({
    session: {
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
      releaseAudioForPlayback: () => {
        events.push("audio_sink");
        return false;
      },
    },
    motionSink: {
      interrupt: () => {},
      start: () => {
        events.push("motion_sink");
        return true;
      },
    },
  });

  const result = runtime.startSegmentJob({
    messageId: "msg-audio-release-failed",
    turnId: "turn-audio-release-failed",
    reason: "test",
    text: {
      release: false,
    },
    audio: {
      release: true,
      noAudioConfirmed: false,
    },
    motion: {
      payload: motionPayload,
      receivedAtMs: 123,
    },
  });

  assert.deepEqual(result, {
    releasedText: false,
    releasedAudio: false,
    releasedMotion: false,
  });
  assert.deepEqual(events, [
    "audio_sink",
  ]);
  assert.equal(
    runtime.getTimelineSnapshotForSegment(
      "turn-audio-release-failed",
      "msg-audio-release-failed",
    ),
    null,
  );
}
function testPlaybackTimelineRuntimeCreatesMotionOnlyTimelineBesideExistingAudioTimeline(): void {
  const events: string[] = [];
  const runtime = createRuntimeWithSegmentExecutionPorts({
    session: {
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
      interrupt: () => {},
      start: () => {
        events.push("motion_sink");
        return true;
      },
    },
  });
  prepareTestAudioTimeline(runtime, "turn-existing", "msg-existing");

  const result = runtime.startSegmentJob({
    messageId: "msg-motion-only-missing-timeline",
    turnId: "turn-motion-only-missing-timeline",
    reason: "test",
    text: {
      release: false,
    },
    audio: {
      release: false,
      noAudioConfirmed: true,
    },
    motion: {
      payload: motionPayload,
      receivedAtMs: 123,
    },
  });

  assert.deepEqual(result, {
    releasedText: false,
    releasedAudio: false,
    releasedMotion: true,
  });
  assert.deepEqual(events, [
    "motion_sink",
    "motion_released",
    "phase:playing",
  ]);
  assert.equal(
    runtime.getTimelineSnapshotForSegment("turn-existing", "msg-existing")?.messageId,
    "msg-existing",
  );
  assert.equal(
    runtime.getTimelineSnapshotForSegment(
      "turn-motion-only-missing-timeline",
      "msg-motion-only-missing-timeline",
    )?.messageId,
    "msg-motion-only-missing-timeline",
  );
}
async function run(): Promise<void> {
  await testSegmentsReleaseSequentiallyWithinTurn();
  await testTextAndMotionReleaseWhenAudioIsAbsent();
  await testAudioCaptionOnlySegmentDoesNotReleaseVisibleText();
  await testVisibleTextArrivingAfterAudioCaptionIsReleasedOnce();
  await testMotionReleaseReceivesMatchingAudioTimeline();
  await testMotionReleaseRejectsMismatchedAudioTimeline();
  await testRejectedMotionReleaseMarksSegmentFailed();
  await testMotionWithoutReceivedAtMarksSegmentFailed();
  await testPerformanceCurveHintIsMergedBeforeMotionRelease();
  testMotionTimelineSinkLeavesRejectedTerminalOwnershipToEngine();
  testMotionTimelineSinkUsesPreparedSyntheticTimelineWhenAudioAbsent();
  testMotionTimelineSinkRetainsPreparingAudioTimelineOwnership();
  testMotionTimelineSinkRejectsMissingAudioTimeline();
  testMotionTimelineSinkRejectsMissingMotionOnlyTimeline();
  testMotionTimelineSinkUsesSegmentScopedTimelineLookup();
  testPlaybackTimelineRuntimeRejectsInvalidMotionTimestamp();
  testPlaybackTimelineRuntimeMarksMotionOnlyContext();
  testPlaybackTimelineRuntimePreparesAudioMotionTimeline();
  testPlaybackTimelineRuntimeDoesNotReleaseMotionWhenAudioReleaseFails();
  testPlaybackTimelineRuntimeCreatesMotionOnlyTimelineBesideExistingAudioTimeline();
  console.log("useTurnPlaybackOrchestrator tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
