// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { effectScope, nextTick } from "vue";
import { useTurnPlaybackSessionStore } from "../src/composables/useTurnPlaybackSessionStore.js";
import { useTurnPlaybackOrchestrator } from "../src/composables/useTurnPlaybackOrchestrator.js";
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
      orchestrationId: string | null,
    ): boolean {
      released.push(`text:${messageId}:${turnId ?? ""}:${orchestrationId ?? ""}`);
      return true;
    },
    releaseAudioForPlayback(
      messageId: string,
      turnId: string | null,
      orchestrationId: string | null,
    ): Promise<boolean> {
      released.push(`audio:${messageId}:${turnId ?? ""}:${orchestrationId ?? ""}`);
      return Promise.resolve(true);
    },
  };

  const modelEngine = {
    ingestNormalizedPayload(
      _payload: NormalizedMotionPayload,
      context: { messageId: string; turnId: string | null; orchestrationId?: string | null },
    ): void {
      released.push(
        `motion:${context.messageId}:${context.turnId ?? ""}:${context.orchestrationId ?? ""}`,
      );
    },
    notifyCurrentTurnChanged(turnId: string | null): void {
      turnChanges.push(turnId);
    },
  };

  scope.run(() => {
    useTurnPlaybackOrchestrator({
      sessionStore,
      adapter: adapter as never,
      modelEngine: modelEngine as never,
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
  h.sessionStore.setActiveSession("orch-1", "turn-1");
  h.sessionStore.markTurnStarted("orch-1", "turn-1");

  h.sessionStore.markTextReceived("orch-1", "turn-1", "A", "msg-a");
  h.sessionStore.markAudioReceived("orch-1", "turn-1", "http://localhost/a.wav", "msg-a");
  h.sessionStore.markMotionReceived("orch-1", "turn-1", motionPayload, "msg-a");

  h.sessionStore.markTextReceived("orch-1", "turn-1", "B", "msg-b");
  h.sessionStore.markAudioReceived("orch-1", "turn-1", "http://localhost/b.wav", "msg-b");
  h.sessionStore.markMotionReceived("orch-1", "turn-1", motionPayload, "msg-b");

  await h.flush();
  await h.flush();

  assert.deepEqual(h.released, [
    "text:msg-a:turn-1:orch-1",
    "motion:msg-a:turn-1:orch-1",
    "audio:msg-a:turn-1:orch-1",
  ]);

  h.sessionStore.markTextDelivered("orch-1", "turn-1", "msg-a");
  h.sessionStore.markAudioTerminal("orch-1", "turn-1", "completed", "msg-a");
  h.sessionStore.markMotionCompleted("orch-1", "turn-1", "msg-a");

  await h.flush();
  await h.flush();

  assert.deepEqual(h.released, [
    "text:msg-a:turn-1:orch-1",
    "motion:msg-a:turn-1:orch-1",
    "audio:msg-a:turn-1:orch-1",
    "text:msg-b:turn-1:orch-1",
    "motion:msg-b:turn-1:orch-1",
    "audio:msg-b:turn-1:orch-1",
  ]);
  h.stop();
}

async function run(): Promise<void> {
  await testSegmentsReleaseSequentiallyWithinTurn();
  console.log("useTurnPlaybackOrchestrator tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
