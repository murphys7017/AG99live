import assert from "node:assert/strict";
import { nextTick } from "vue";
import { mapInboundEnvelopeToEvent } from "../src/adapter-connection/inbound/inboundEvents.js";
import { useTurnPlaybackSessionStore } from "../src/turn-playback/useTurnPlaybackSessionStore.js";
import { usePlaybackCompletionCoordinator } from "../src/turn-playback/usePlaybackCompletionCoordinator.js";
import type { ProtocolEnvelope } from "../src/types/protocol.js";

async function run(): Promise<void> {
  const envelope: ProtocolEnvelope<unknown> = {
    type: "control.synth_finished", version: "v2", message_id: "terminal",
    timestamp: new Date().toISOString(), turn_id: "turn", source: "adapter",
    payload: { success: false, reason: "provider_stream_failed" },
  };
  const mapped = mapInboundEnvelopeToEvent(envelope);
  assert.equal(mapped.kind, "synth_finished");
  if (mapped.kind !== "synth_finished") throw new Error("terminal not parsed");

  const store = useTurnPlaybackSessionStore();
  store.markTurnStarted("turn");
  store.commitOutputSegment("turn", "prefix", {
    state: "accepted", text: { state: "present", content: "已收到的前缀" },
    audio: { state: "absent" }, motion: { state: "absent" }, speech: { state: "absent" },
  });
  const acknowledgements: { success: boolean; reason: string | undefined }[] = [];
  const coordinator = usePlaybackCompletionCoordinator({
    sessionStore: store,
    timelineRuntime: {
      findOpenExecutionTimelineSegments: () => [],
      subscribeExecutionStateChanges: () => () => {},
    },
    playbackAck: {
      clearPlaybackGroupContext: () => {},
      async sendPlaybackFinishedForCurrentGroup(_turn, success, reason) {
        acknowledgements.push({ success, reason });
        return true;
      },
    },
  });
  try {
    store.markSynthFinished("turn", mapped.success, mapped.reason);
    await nextTick();
    assert.deepEqual(acknowledgements, []);
    assert.notEqual(store.getSession("turn")?.phase, "failed");
    assert.equal(store.getSession("turn")?.segments.get("prefix")?.text.content, "已收到的前缀");
    store.markTextDelivered("turn", "prefix");
    await nextTick();
    assert.deepEqual(acknowledgements, [{ success: false, reason: "provider_stream_failed" }]);

    const rejected = mapInboundEnvelopeToEvent(
      { ...envelope, payload: { success: false } },
    );
    assert.equal(rejected.kind, "protocol_error");

    // Optional motion generation failure preserves successful core delivery.
    store.markTurnStarted("optional-motion");
    store.commitOutputSegment("optional-motion", "reply", {
      state: "accepted", text: { state: "present", content: "正常回复" },
      audio: { state: "absent" },
      motion: { state: "failed", reason: "motion_timeout" },
      speech: { state: "absent" },
    });
    store.markSynthFinished("optional-motion", true, "");
    store.markTextDelivered("optional-motion", "reply");
    await nextTick();
    assert.equal(acknowledgements.length, 2);
    assert.deepEqual(acknowledgements[1], {
      success: true, reason: "playback_state_changed",
    });
    assert.equal(
      store.getSession("optional-motion")?.segments.get("reply")?.motion.reason,
      "motion_timeout",
    );

    // With no core output, a failed action-only segment is still a real failure.
    store.markTurnStarted("motion-only");
    store.commitOutputSegment("motion-only", "action", {
      state: "accepted", text: { state: "absent" }, audio: { state: "absent" },
      motion: { state: "failed", reason: "motion_timeout" },
      speech: { state: "absent" },
    });
    store.markSynthFinished("motion-only", true, "");
    await nextTick();
    assert.deepEqual(acknowledgements[2], { success: false, reason: "motion_timeout" });
  } finally {
    coordinator.dispose();
  }
  console.info("streamFailureCompletion boundary passed");
}

await run();
