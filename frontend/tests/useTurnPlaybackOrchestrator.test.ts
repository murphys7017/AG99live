// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { effectScope, nextTick } from "vue";
import { useTurnPlaybackSessionStore } from "../src/turn-playback/useTurnPlaybackSessionStore.js";
import { useTurnPlaybackOrchestrator } from "../src/turn-playback/useTurnPlaybackOrchestrator.js";
import type { NormalizedMotionPayload } from "../src/model-engine/contracts.js";
import type { PerformanceCurveHint } from "../src/types/protocol.js";

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

function createHarness(options: { motionAccepted?: boolean } = {}) {
  const sessionStore = useTurnPlaybackSessionStore();
  const released: string[] = [];
  const motionPayloads: NormalizedMotionPayload[] = [];
  const turnChanges: Array<string | null> = [];
  const logs: Array<{ message: string; details: Record<string, unknown> }> = [];
  const scope = effectScope();
  const originalConsoleInfo = console.info;
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

  const modelEngine = {
    ingestNormalizedPayload(
      payload: NormalizedMotionPayload,
      context: { messageId: string; turnId: string | null },
    ): boolean {
      motionPayloads.push(payload);
      released.push(`motion:${context.messageId}:${context.turnId ?? ""}`);
      return options.motionAccepted ?? true;
    },
    notifyCurrentTurnChanged(turnId: string | null): void {
      turnChanges.push(turnId);
    },
  };

  scope.run(() => {
    useTurnPlaybackOrchestrator({
      sessionStore,
      playbackRelease: adapter,
      motionPayload: modelEngine,
    });
  });

  return {
    sessionStore,
    released,
    motionPayloads,
    turnChanges,
    logs,
    flush: () => nextTick(),
    stop: () => {
      scope.stop();
      console.info = originalConsoleInfo;
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
    "motion:msg-a:turn-1",
    "audio:msg-a:turn-1",
  ]);

  h.sessionStore.markTextDelivered("turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("turn-1", "completed", "msg-a");
  h.sessionStore.markMotionCompleted("turn-1", "msg-a");

  await h.flush();
  await h.flush();

  assert.deepEqual(h.released, [
    "text:msg-a:turn-1",
    "motion:msg-a:turn-1",
    "audio:msg-a:turn-1",
    "text:msg-b:turn-1",
    "motion:msg-b:turn-1",
    "audio:msg-b:turn-1",
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
    "motion:msg-audio-caption:turn-audio-caption",
    "audio:msg-audio-caption:turn-audio-caption",
  ]);
  const segment = h.sessionStore
    .getSession("turn-audio-caption")
    ?.segments.get("msg-audio-caption");
  assert.equal(segment?.text.content, null);
  assert.equal(segment?.audio.captionText, "subtitle only");
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
  h.stop();
}

async function testPerformanceCurveHintIsMergedBeforeMotionRelease(): Promise<void> {
  const h = createHarness();
  h.sessionStore.setActiveSession("turn-curve");
  h.sessionStore.markTurnStarted("turn-curve");

  h.sessionStore.markTextReceived("turn-curve", "hello", "msg-curve");
  h.sessionStore.markMotionReceived("turn-curve", motionPayload, "msg-curve");
  h.sessionStore.markPerformanceCurveHintReceived("turn-curve", curveHint, "msg-curve");
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
  assert.equal(storedPayload.intent.performance_curve_hint, undefined);
  h.stop();
}

async function testLateAudioAfterTextReleaseOnlyReleasesAudio(): Promise<void> {
  const h = createHarness();
  h.sessionStore.setActiveSession("turn-late-audio");
  h.sessionStore.markTurnStarted("turn-late-audio");

  h.sessionStore.markTextReceived("turn-late-audio", "hello", "msg-late-audio");
  h.sessionStore.markSynthFinished("turn-late-audio");
  h.sessionStore.markAudioTerminal(
    "turn-late-audio",
    "absent",
    "msg-late-audio",
    "synth_finished_without_audio_playback",
  );

  await h.flush();
  await h.flush();
  assert.deepEqual(h.released, [
    "text:msg-late-audio:turn-late-audio",
  ]);

  assert.equal(
    h.sessionStore.markAudioReceived(
      "turn-late-audio",
      "http://localhost/late.wav",
      "msg-late-audio",
    ),
    true,
  );

  await h.flush();
  await h.flush();

  assert.deepEqual(h.released, [
    "text:msg-late-audio:turn-late-audio",
    "audio:msg-late-audio:turn-late-audio",
  ]);
  h.stop();
}

async function run(): Promise<void> {
  await testSegmentsReleaseSequentiallyWithinTurn();
  await testTextAndMotionReleaseWhenAudioIsAbsent();
  await testAudioCaptionOnlySegmentDoesNotReleaseVisibleText();
  await testRejectedMotionReleaseMarksSegmentFailed();
  await testPerformanceCurveHintIsMergedBeforeMotionRelease();
  await testLateAudioAfterTextReleaseOnlyReleasesAudio();
  console.log("useTurnPlaybackOrchestrator tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
