import assert from "node:assert/strict";
import { nextTick } from "vue";
import { useTurnPlaybackSessionStore } from "../src/turn-playback/useTurnPlaybackSessionStore.js";
import { useTurnPlaybackOrchestrator } from "../src/turn-playback/useTurnPlaybackOrchestrator.js";
import { createPlaybackTimelineRuntime } from "../src/playback-timeline/playbackTimelineRuntime.js";
import { normalizeMotionPayload } from "../src/model-engine/normalize.js";
import { applyDeferredMotion } from "../src/adapter-connection/inbound/deferredMotionProtocol.js";
import type { NormalizedMotionPayload } from "../src/types/motion.js";
import type { MotionPlanPayload, ProtocolEnvelope } from "../src/types/protocol.js";
import { SCHEMA_PERFORMANCE_CURVE_HINT_V1 } from "../src/types/protocol.js";
import { createIncrementalOutputRuntime } from "../src/adapter-connection/inbound/incrementalOutputRuntime.js";
import { useModelEngine } from "../src/model-engine/useModelEngine.js";
import { parseSemanticParameterPlan } from "../src/model-engine/planParser.js";
import type { MotionPlaybackClockReader } from "../src/model-engine/contracts.js";
import { createModelEngineMotionTimelineSink } from "../src/playback-integrations/modelEngineMotionSink.js";
import { configurePlaybackTimelineMotionRuntime } from "../src/app/playbackTimelineWiring.js";
import { parseSystemModelSyncPayload } from "../src/adapter-connection/inbound/modelSyncPayload.js";
import { makeValidModelSummary, makeValidSemanticAxisProfile } from "./fixtures/modelSyncFixture.js";

const modelSync = parseSystemModelSyncPayload({
  type: "system.model_sync", source: "adapter", version: "v2", message_id: "model-sync", turn_id: null,
  timestamp: new Date().toISOString(), payload: {
    model_info: {
      schema_version: "live2d_scan.v4", selected_model: "model:1", available_models: ["model:1"],
      models: [makeValidModelSummary({
        name: "model:1",
        semantic_axis_profile: {
          ...makeValidSemanticAxisProfile("model:1"), profile_id: "profile:1",
          axes: [{
            id: "head_yaw", label: "Head yaw", description: "", semantic_group: "head",
            control_role: "primary", neutral: 0, value_range: [-30, 30], soft_range: [-8, 8],
            strong_range: [-20, 20], extreme_range: [-30, 30],
            level_anchors: { "-4": -30, "-3": -22, "-2": -15, "-1": -8, "0": 0, "1": 8, "2": 15, "3": 22, "4": 30 },
            positive_semantics: [], negative_semantics: [], usage_notes: "",
            dynamics: { max_velocity: 1, max_acceleration: 1, max_speech_offset_ratio: 0.1 },
            parameter_bindings: [{ parameter_id: "ParamAngleX", input_range: [-30, 30], output_range: [-30, 30], default_weight: 1, invert: false }],
          }],
        },
      })],
    },
    runtime_cache_errors: {},
  },
});
assert.ok(modelSync.ok);
const model = modelSync.payload.model_info.models[0];
assert.ok(model);

const store = useTurnPlaybackSessionStore({ normalizeMotionPayload });
let audioStarts = 0;
let motionStarts = 0;
let audioElapsedMs = 500;
const motionClocks: MotionPlaybackClockReader[] = [];
const motionPlans: MotionPlanPayload[] = [];
const handoffs: string[] = [];
const engine = useModelEngine({
  getSelectedModel: () => model,
  getSettings: () => ({}),
  playPlan(plan, _model, options) {
    const parsed = parseSemanticParameterPlan(plan);
    assert.ok(parsed.ok);
    assert.ok(options.playbackClockReader);
    motionClocks.push(options.playbackClockReader);
    motionPlans.push(parsed.value);
    motionStarts++;
    options.onStarted(parsed.value, `run:${motionStarts}`);
    return { status: "started", runId: `run:${motionStarts}` };
  },
  playMotionResource: () => { throw new Error("Unexpected resource playback"); },
  stopPlan(reason) { handoffs.push(reason ?? "stopped"); },
  stopInteractionSway() {}, startInteractionSway: () => false,
  canStartSpeechOnlyMotion: () => false,
  onPlanStarted(event) { runtime.markMotionTimelineStarted(event.turnId, event.messageId); },
  onMotionRejected(event) { runtime.markMotionTimelineTerminal(event.turnId, event.messageId, "failed", event.reason); },
});
const motionSink = createModelEngineMotionTimelineSink({
  motionEngine: engine,
  getPlaybackTimelineSnapshotForSegment: (...args) => runtime.getTimelineSnapshotForSegment(...args),
  getPlaybackTimelineClockReaderForSegment: (...args) => runtime.getTimelineClockReaderForSegment(...args),
  markMotionTimelineTerminal: (...args) => runtime.markMotionTimelineTerminal(...args),
});
const runtime = createPlaybackTimelineRuntime<NormalizedMotionPayload>({
  segmentExecution: {
    session: store,
    textSink: {
      releaseAssistantTextForPlayback(_text, messageId, turnId) { store.markTextDelivered(turnId, messageId); return true; },
      failAssistantTextForPlayback() { return true; },
    },
    audioSink: { releaseAudioForPlayback() { audioStarts++; return true; } },
    motionSink,
  },
  audioSession: store,
  motionSession: store,
  onAudioTimelineDurationReady: (...args) => wiring.handleAudioTimelineDurationReady(...args),
  onAudioTimelineStarted: (...args) => wiring.handleAudioTimelineStarted(...args),
});
const wiring = configurePlaybackTimelineMotionRuntime({
  playbackTimeline: runtime, motionEngine: engine,
  getCanonicalAssistantText: () => "hello", getCanonicalSpeechCues: () => [],
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
runtime.attachAudioTimelineClock("turn:1", "segment:1", {
  getCurrentTimeMs: () => audioElapsedMs, getDurationMs: () => 2000, getPlaybackRate: () => 1, isPlaying: () => false,
});
runtime.markAudioTimelineDuration("turn:1", "segment:1", 2000);
runtime.markAudioTimelineStarted("turn:1", "segment:1", performance.now(), 2000, {
  getCurrentTimeMs: () => audioElapsedMs, getDurationMs: () => 2000, getPlaybackRate: () => 1, isPlaying: () => true,
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
assert.equal(motionClocks[0]!.getElapsedMs(), 0, "late plan must start at its own first sample");
audioElapsedMs = 750;
assert.equal(motionClocks[0]!.getElapsedMs(), 250, "motion must follow the same audio clock from its attachment origin");
assert.equal(audioStarts, 1, "late motion must not replay audio");
store.assertOutputSegmentsResolved("turn:1");
assert.throws(() => applyDeferredMotion(envelope, store, normalizeMotionPayload), /state_invalid/);
store.commitOutputSegment("turn:1", "segment:2", {
  state: "accepted", text: { state: "present", content: "next" },
  audio: { state: "present", url: "http://localhost/next.wav" },
  motion: { state: "pending" }, speech: { state: "absent" },
});
orchestrator.flush();
assert.equal(audioStarts, 1, "next audio must not overlap playing audio");
runtime.markAudioTimelineTerminal("turn:1", "segment:1", "completed", "audio_ended");
await nextTick();
orchestrator.flush();
assert.equal(audioStarts, 2, "ready next speech must not wait for the previous motion tail");
assert.deepEqual(handoffs, ["speech_segment_handoff"]);
assert.equal(store.getSession("turn:1")?.segments.get("segment:1")?.motion.completed, true);
assert.equal(store.getSession("turn:1")?.segments.get("segment:1")?.motion.failed, false);
audioElapsedMs = 2000;
runtime.markAudioTimelineStarted("turn:1", "segment:2", performance.now(), 2000, {
  getCurrentTimeMs: () => audioElapsedMs, getDurationMs: () => 2000, getPlaybackRate: () => 1, isPlaying: () => true,
});
applyDeferredMotion({ ...envelope, message_id: "segment:2" }, store, normalizeMotionPayload);
await nextTick();
orchestrator.flush();
assert.equal(motionStarts, 1, "an exhausted audio window must not play deferred motion");
assert.equal(store.getSession("turn:1")?.segments.get("segment:2")?.motion.reason, "late_motion_audio_window_unavailable");
assert.equal(engine.state.status, "failed", "rejected deferred motion must not leave the engine pending");
runtime.markAudioTimelineTerminal("turn:1", "segment:2", "completed", "audio_ended");

// M2 has a valid consuming audio clock before its total duration or EOF exists.
store.markTurnStarted("turn:2");
const inbound = createIncrementalOutputRuntime({
  getStore: () => store, currentTurnId: () => "turn:2",
  openPcm: async () => { throw new Error("Unexpected audio replay"); },
  displayText() {}, recordText() {}, sendAudioCredit() {},
  onAsyncError(error) { throw error; },
});
const identity = (resource: string, seq: number) => ({
  turnId: "turn:2", coreTurnId: "core:2", personaResultId: "persona:2", segmentIndex: 0,
  messageId: "segment:pcm", streamId: `pcm:${resource}`, seq,
});
for (const resource of ["text", "audio", "motion"] as const) {
  inbound.handleEvent({ kind: "start", resource, identity: identity(resource, 0) });
}
inbound.handleEvent({ kind: "delta", resource: "text", identity: identity("text", 1), text: "hello" });
audioElapsedMs = 500;
runtime.startAudioTimelineSink("turn:2", "segment:pcm", { start: () => true });
runtime.markAudioTimelineStarted("turn:2", "segment:pcm", performance.now(), null, {
  getCurrentTimeMs: () => audioElapsedMs, getDurationMs: () => null, getPlaybackRate: () => 1, isPlaying: () => true,
});
inbound.handleEvent({ kind: "update", resource: "motion", identity: identity("motion", 1), motionPayload: {
  schema_version: "engine.motion_intent.v4", profile_id: "profile:1", profile_revision: 1,
  model_id: "model:1", mode: "expressive", emotion_label: "happy", intent_tags: ["happy"], axis_levels: { head_yaw: 2 },
  performance_curve_hint: { schema_version: SCHEMA_PERFORMANCE_CURVE_HINT_V1, curve_family: "default", entry: "quick", hold: "steady", exit: "soft", emphasis: "none", energy: "calm" },
} });
await nextTick();
orchestrator.flush();
assert.equal(motionStarts, 2, "open PCM must start motion without waiting for EOF/total duration");
assert.equal(motionClocks[1]!.getElapsedMs(), 0);
audioElapsedMs = 750;
assert.equal(motionClocks[1]!.getElapsedMs(), 250);
assert.ok(motionPlans[1]!.timing.curve_preset, "open PCM must retain the declared action curve");
assert.equal(store.getSession("turn:2")?.segments.get("segment:pcm")?.incremental?.streams.audio?.status, "open");
assert.equal(store.getSession("turn:2")?.segments.get("segment:pcm")?.motion.started, true);
runtime.stopTimelinesForTurn("turn:2", "user_interrupt");
assert.ok(handoffs.includes("user_interrupt"));
inbound.reset();
orchestrator.dispose();
runtime.stopAllTimelines("test_complete");
console.log("Complete-audio/late-motion timeline boundary passed.");
