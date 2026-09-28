import assert from "node:assert/strict";
import {
  buildPerformanceCompositionSignature,
} from "../src/model-engine/compiler/performanceComposition.js";
import { compileSemanticMotion } from "../src/model-engine/compiler/compileSemanticMotion.js";
import { SCHEMA_MOTION_INTENT_V4 } from "../src/types/protocol.js";
import type { NormalizedSemanticMotionIntentV4 } from "../src/types/protocol.js";
import type { SemanticAxisProfile } from "../src/types/semantic-axis-profile.js";
import type { CompileOptions } from "../src/model-engine/compiler/contracts.js";
import { makeValidModelSummary } from "./fixtures/modelSyncFixture.js";

const profile: SemanticAxisProfile = {
  schema_version: "ag99.semantic_axis_profile.v3",
  profile_id: "profile-1",
  model_id: "model-1",
  source_hash: "hash",
  last_scanned_hash: "hash",
  revision: 1,
  status: "generated",
  user_modified: false,
  generated_at: "",
  updated_at: "",
  axes: [
    buildAxis("head_yaw", "head"),
    buildAxis("head_pitch", "head"),
    buildAxis("body_yaw", "body"),
    buildAxis("torso_yaw", "torso"),
    buildAxis("gaze_x", "gaze"),
  ],
  relation_graph: {
    schema_version: "ag99.semantic_axis_relation_graph.v1",
    edges: [{
      id: "head-body",
      source_axis_id: "head_yaw",
      target_axis_id: "body_yaw",
      kind: "bounded_ratio",
      mode: "same_direction",
      scale: 0.7,
      deadzone: 0,
      max_delta: 100,
    }],
  },
};

function buildAxis(id: string, semanticGroup: string) {
  return {
    id,
    label: id,
    description: "",
    semantic_group: semanticGroup,
    control_role: "primary" as const,
    neutral: 0,
    value_range: [-100, 100] as [number, number],
    soft_range: [-20, 20] as [number, number],
    strong_range: [-60, 60] as [number, number],
    extreme_range: [-100, 100] as [number, number],
    level_anchors: {
      "-4": -100,
      "-3": -75,
      "-2": -50,
      "-1": -25,
      "0": 0,
      "1": 25,
      "2": 50,
      "3": 75,
      "4": 100,
    },
    positive_semantics: [],
    negative_semantics: [],
    usage_notes: "",
    dynamics: {
      max_velocity: 1,
      max_acceleration: 1,
      max_speech_offset_ratio: 0.1,
    },
    parameter_bindings: [],
  };
}

function testAlignedComposition(): void {
  const signature = buildPerformanceCompositionSignature(profile, [
    { axisId: "head_yaw", value: -60, neutralValue: 0, source: "semantic_axis" },
    { axisId: "body_yaw", value: -30, neutralValue: 0, source: "relation_graph" },
    { axisId: "gaze_x", value: -70, neutralValue: 0, source: "relation_graph" },
  ]);

  assert.equal(signature.primaryAxis, "gaze_x");
  assert.equal(signature.primaryDirection, "negative");
  assert.equal(signature.skeletonAlignment, "aligned");
  assert.deepEqual(signature.warnings, []);
  assert.deepEqual(signature.activeGroups, ["body", "gaze", "head"]);
}

function testOpposedCompositionIsOnlyDiagnosed(): void {
  const signature = buildPerformanceCompositionSignature(profile, [
    { axisId: "head_yaw", value: -60, neutralValue: 0, source: "semantic_axis" },
    { axisId: "body_yaw", value: 40, neutralValue: 0, source: "semantic_axis" },
  ]);

  assert.equal(signature.skeletonAlignment, "opposed");
  assert.deepEqual(signature.warnings, ["skeleton_relation_direction_conflict"]);
  assert.equal(signature.primaryDirection, "negative");
}

function testIndependentDimensionsAreNotReportedAsOpposed(): void {
  const signature = buildPerformanceCompositionSignature(profile, [
    { axisId: "head_pitch", value: 55, neutralValue: 0, source: "semantic_axis" },
    { axisId: "gaze_x", value: -60, neutralValue: 0, source: "semantic_axis" },
  ]);

  assert.equal(signature.skeletonAlignment, "partial");
  assert.deepEqual(signature.warnings, []);
}

function testTorsoUsesTheSharedBodyCompositionRole(): void {
  const signature = buildPerformanceCompositionSignature(profile, [
    { axisId: "head_yaw", value: -60, neutralValue: 0, source: "semantic_axis" },
    { axisId: "torso_yaw", value: -50, neutralValue: 0, source: "semantic_axis" },
  ]);

  assert.equal(signature.skeletonAlignment, "aligned");
  assert.equal(signature.bodyInvolvement, 0.5);
}

function testSemanticCompilationKeepsSkeletonSamplingDeterministic(): void {
  const intent: NormalizedSemanticMotionIntentV4 = {
    schema_version: SCHEMA_MOTION_INTENT_V4,
    profile_id: profile.profile_id,
    profile_revision: profile.revision,
    model_id: profile.model_id,
    mode: "expressive" as const,
    intent_tags: ["look_left"],
    emotion_label: "look_left",
    axis_levels: {
      head_yaw: -3,
      gaze_x: -3,
    },
  };
  const options: CompileOptions = {
    model: makeValidModelSummary({
      name: profile.model_id,
      semantic_axis_profile: profile,
    }) as unknown as CompileOptions["model"],
    settings: { motionIntensityScale: 1 },
    samplingIdentity: {
      turnId: "turn-1",
      messageId: "message-1",
    },
  };
  const first = compileSemanticMotion(intent, options);
  const second = compileSemanticMotion(intent, options);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok || first.motion.kind !== "pose" || second.motion.kind !== "pose") {
    throw new Error("Expected deterministic semantic pose compilation.");
  }
  assert.deepEqual(first.motion.axes, second.motion.axes);
  assert.deepEqual(
    first.motion.diagnostics.transformTrace?.axisSampling,
    second.motion.diagnostics.transformTrace?.axisSampling,
  );
  assert.equal(
    first.motion.diagnostics.transformTrace?.transformVersion,
    "semantic_motion_transform.v6",
  );
  assert.ok(
    typeof first.motion.diagnostics.transformTrace?.axisSampling?.groupRandom.skeleton
      === "number",
  );
}

testAlignedComposition();
testOpposedCompositionIsOnlyDiagnosed();
testIndependentDimensionsAreNotReportedAsOpposed();
testTorsoUsesTheSharedBodyCompositionRole();
testSemanticCompilationKeepsSkeletonSamplingDeterministic();
console.log("performance composition tests passed");
