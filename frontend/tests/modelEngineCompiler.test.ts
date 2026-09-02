import assert from "node:assert/strict";
import { normalizeMotionPayload } from "../src/model-engine/normalize.js";

function buildBasePayload() {
  return {
    schema_version: "engine.motion_intent.v4",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    intent_tags: ["happy"],
    emotion_label: "happy",
  };
}

function testAcceptsAxisLevels(): void {
  const result = normalizeMotionPayload({
    ...buildBasePayload(),
    axis_levels: {
      head_yaw: -4,
      mouth_smile: 4,
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok || result.payload.kind !== "semantic_intent") {
    throw new Error("Expected a normalized semantic motion intent.");
  }
  assert.equal(result.payload.intent.schema_version, "engine.motion_intent.v4");
  assert.deepEqual(result.payload.intent.axis_levels, {
    head_yaw: -4,
    mouth_smile: 4,
  });
}

function testAcceptsMotionSequence(): void {
  const result = normalizeMotionPayload({
    ...buildBasePayload(),
    motion_steps: [
      { axis_levels: { head_yaw: -3 }, duration_weight: 1 },
      { axis_levels: { head_pitch: 2 }, duration_weight: 2 },
      { axis_levels: { head_yaw: 0 }, duration_weight: 1 },
    ],
  });

  assert.equal(result.ok, true);
  if (
    !result.ok
    || result.payload.kind !== "semantic_intent"
    || result.payload.intent.schema_version !== "engine.motion_intent.v4"
  ) {
    throw new Error("Expected a normalized semantic motion sequence.");
  }
  assert.deepEqual(result.payload.intent.motion_steps, [
    { axis_levels: { head_yaw: -3 }, duration_weight: 1 },
    { axis_levels: { head_pitch: 2 }, duration_weight: 2 },
    { axis_levels: { head_yaw: 0 }, duration_weight: 1 },
  ]);
}

function testRejectsInvalidAxisLevels(): void {
  const result = normalizeMotionPayload({
    ...buildBasePayload(),
    axis_levels: { head_yaw: 5 },
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error("Expected invalid axis levels to be rejected.");
  }
  assert.equal(result.reason, "motion_intent_v4.invalid_axis_levels");
}

testAcceptsAxisLevels();
testAcceptsMotionSequence();
testRejectsInvalidAxisLevels();
console.log("modelEngineCompiler smoke tests passed");
