// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { effectScope, nextTick } from "vue";
import { useTurnPlaybackSessionStore } from "../src/turn-playback/useTurnPlaybackSessionStore.js";
import { useTurnPlaybackOrchestrator } from "../src/turn-playback/useTurnPlaybackOrchestrator.js";
import type { NormalizedMotionPayload } from "../src/model-engine/contracts.js";

const motionPayload: NormalizedMotionPayload = {
  kind: "semantic_intent",
  intent: {} as never,
};

function createHarness() {
  const sessionStore = useTurnPlaybackSessionStore();
  const released: string[] = [];
  const turnChanges: Array<string | null> = [];
  const scope = effectScope();

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
      _payload: NormalizedMotionPayload,
      context: { messageId: string; turnId: string | null },
    ): void {
      released.push(`motion:${context.messageId}:${context.turnId ?? ""}`);
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
    turnChanges,
    flush: () => nextTick(),
    stop: () => scope.stop(),
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
  h.stop();
}

async function run(): Promise<void> {
  await testSegmentsReleaseSequentiallyWithinTurn();
  await testTextAndMotionReleaseWhenAudioIsAbsent();
  console.log("useTurnPlaybackOrchestrator tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
