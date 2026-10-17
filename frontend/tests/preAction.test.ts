import assert from "node:assert/strict";
import { useModelEngine } from "../src/model-engine/useModelEngine.js";
import { normalizeMotionPayload } from "../src/model-engine/normalize.js";
import { parseSemanticParameterPlan } from "../src/model-engine/planParser.js";
import { parseSystemModelSyncPayload } from "../src/adapter-connection/inbound/modelSyncPayload.js";
import { parsePreAction } from "../src/adapter-connection/inbound/preActionProtocol.js";
import { makeValidModelSummary, makeValidSemanticAxisProfile } from "./fixtures/modelSyncFixture.js";

const modelResult = parseSystemModelSyncPayload({
  type: "system.model_sync", version: "v2", source: "adapter", turn_id: null,
  message_id: "sync", timestamp: new Date().toISOString(), payload: {
    runtime_cache_errors: {}, model_info: {
      schema_version: "live2d_scan.v4", selected_model: "m", available_models: ["m"],
      models: [makeValidModelSummary({ name: "m", semantic_axis_profile: {
        ...makeValidSemanticAxisProfile("m"), profile_id: "p", axes: [{
          id: "head_yaw", label: "Head yaw", description: "", semantic_group: "head", control_role: "primary",
          neutral: 0, value_range: [-30, 30], soft_range: [-8, 8], strong_range: [-20, 20], extreme_range: [-30, 30],
          level_anchors: { "-1": -8, "0": 0, "1": 8 }, positive_semantics: [], negative_semantics: [], usage_notes: "",
          dynamics: { max_velocity: 1, max_acceleration: 1, max_speech_offset_ratio: 0.1 },
          parameter_bindings: [{ parameter_id: "ParamAngleX", input_range: [-30, 30], output_range: [-30, 30], default_weight: 1, invert: false }],
        }, {
          id: "head_roll", label: "Head roll", description: "", semantic_group: "head", control_role: "primary",
          neutral: 0, value_range: [-30, 30], soft_range: [-8, 8], strong_range: [-20, 20], extreme_range: [-30, 30],
          level_anchors: { "-1": -8, "0": 0, "1": 8 }, positive_semantics: [], negative_semantics: [], usage_notes: "",
          dynamics: { max_velocity: 1, max_acceleration: 1, max_speech_offset_ratio: 0.1 },
          parameter_bindings: [{ parameter_id: "ParamAngleZ", input_range: [-30, 30], output_range: [-30, 30], default_weight: 1, invert: false }],
        }],
      } })],
    },
  },
});
assert.ok(modelResult.ok);
const model = modelResult.payload.model_info.models[0];
const envelope = {
  type: "output.pre_action", version: "v2" as const, source: "adapter", turn_id: "input:1", message_id: "pre:1",
  timestamp: new Date().toISOString(), payload: {
    schema_version: "olv.pre_action.v1", action: "ready", request_id: "r1", expires_at_epoch_ms: Date.now() + 800,
    motion: { schema_version: "engine.motion_intent.v4", profile_id: "p", profile_revision: 1, model_id: "m",
      mode: "expressive", emotion_label: "关注", intent_tags: ["关注"], axis_levels: { head_yaw: 1, head_roll: 1 }, duration_hint_ms: 1000 },
  },
};
const ready = parsePreAction(envelope, normalizeMotionPayload);
assert.equal(ready.action, "ready");
if (ready.action !== "ready") throw new Error("Expected pre-action");
const starts: string[] = [];
const engine = useModelEngine({
  getSelectedModel: () => model, getSettings: () => ({}),
  playPlan(plan, _model, options) {
    const runId = `run:${starts.length}`;
    const parsed = parseSemanticParameterPlan(plan);
    assert.ok(parsed.ok);
    if (starts.length === 1) {
      const release = parsed.value.parameters.find((p) => p.parameter_id === "ParamAngleZ");
      assert.equal(release?.source, "continuity");
      assert.equal(release?.target_value, release?.neutral_target_value);
    }
    options.onStarted(parsed.value, runId);
    return { status: "started", runId };
  },
  playMotionResource: () => { throw new Error("Unexpected resource"); },
  stopPlan() {}, stopInteractionSway() {}, startInteractionSway: () => false,
  canStartSpeechOnlyMotion: () => false,
  onPlanStarted(event) { starts.push(event.playbackOrigin); },
  onMotionRejected(event) { throw new Error(event.reason); },
});
assert.equal(engine.startPreAction(ready.motion, ready.turnId, ready.requestId), true);
assert.deepEqual(starts, ["pre_action"]);
const formal = normalizeMotionPayload({ ...envelope.payload.motion, axis_levels: { head_yaw: 1 } });
assert.ok(formal.ok);
assert.equal(engine.ingestNormalizedPayload(formal.payload, {
  turnId: "input:1", messageId: "formal:1", assistantText: "你好", speechCues: [],
  receivedAtMs: performance.now(), timelineMode: "motion_only",
  playbackClock: { timelineId: "t1", turnId: "input:1", messageId: "formal:1", source: "synthetic",
    phase: "playing", startedAtMs: performance.now(), currentTimeMs: 0, durationMs: 1000 },
  playbackClockReader: { getElapsedMs: () => 0 },
}), true);
assert.deepEqual(starts, ["pre_action", "conversation"]);
assert.equal(engine.startPreAction(ready.motion, ready.turnId, "late"), false);
console.info("Pre-action public ModelEngine admission/handoff check passed.");
