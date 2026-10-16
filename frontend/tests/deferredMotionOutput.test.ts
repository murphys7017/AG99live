import assert from "node:assert/strict";
import { nextTick } from "vue";
import { useTurnPlaybackSessionStore } from "../src/turn-playback/useTurnPlaybackSessionStore.js";
import { useTurnPlaybackOrchestrator } from "../src/turn-playback/useTurnPlaybackOrchestrator.js";
import { createPlaybackTimelineRuntime } from "../src/playback-timeline/playbackTimelineRuntime.js";
import { normalizeMotionPayload } from "../src/model-engine/normalize.js";
import { applyDeferredMotion } from "../src/adapter-connection/inbound/deferredMotionProtocol.js";
import type { NormalizedMotionPayload } from "../src/types/motion.js";
import type { ProtocolEnvelope } from "../src/types/protocol.js";

const store = useTurnPlaybackSessionStore();
let audioStarts = 0;
let motionStarts = 0;
const runtime = createPlaybackTimelineRuntime<NormalizedMotionPayload>({
  segmentExecution: {
    session: store,
    textSink: {
      releaseAssistantTextForPlayback(_text, messageId, turnId) { store.markTextDelivered(turnId, messageId); return true; },
      failAssistantTextForPlayback() { return true; },
    },
    audioSink: { releaseAudioForPlayback() { audioStarts++; return true; } },
    motionSink: { start() { motionStarts++; return true; }, interrupt() {} },
  },
  audioSession: store,
  motionSession: store,
});
store.markTurnStarted("turn:1");
store.commitOutputSegment("turn:1", "segment:1", {
  state: "accepted", text: { state: "present", content: "hello" },
  audio: { state: "present", url: "http://localhost/audio.wav" },
  motion: { state: "pending" }, speech: { state: "absent" },
});
const orchestrator = useTurnPlaybackOrchestrator({ sessionStore: store, timelineRuntime: runtime });
assert.equal(audioStarts, 1, "audio must release before motion is ready");
assert.throws(() => store.assertOutputSegmentsResolved("turn:1"), /Incomplete/);
runtime.markAudioTimelineStarted("turn:1", "segment:1", performance.now(), 2000, {
  getCurrentTimeMs: () => 500, getDurationMs: () => 2000, getPlaybackRate: () => 1, isPlaying: () => true,
});
const envelope: ProtocolEnvelope<unknown> = {
  type: "output.segment_motion", source: "adapter", version: "v2", turn_id: "turn:1",
  message_id: "segment:1", timestamp: new Date().toISOString(), payload: {
    schema_version: "output.segment.v6", motion: {
      state: "present", message_type: "engine.motion_intent", mode: "expressive", source: "independent_provider",
      payload: { schema_version: "engine.motion_intent.v4", profile_id: "profile:1", profile_revision: 1,
        model_id: "model:1", mode: "expressive", emotion_label: "happy", intent_tags: ["happy"], axis_levels: { head_yaw: 2 } },
    },
  },
};
applyDeferredMotion(envelope, store, normalizeMotionPayload);
await nextTick();
orchestrator.flush();
assert.equal(motionStarts, 1, "late motion must start on its active audio timeline");
assert.equal(audioStarts, 1, "late motion must not replay audio");
store.assertOutputSegmentsResolved("turn:1");
assert.throws(() => applyDeferredMotion(envelope, store, normalizeMotionPayload), /state_invalid/);
orchestrator.dispose();
runtime.stopAllTimelines("test_complete");
console.log("Complete-audio/late-motion timeline boundary passed.");
