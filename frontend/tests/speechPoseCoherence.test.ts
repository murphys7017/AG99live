import assert from "node:assert/strict";
import { compileModelParameterPlan } from "../src/model-engine/compiler/compileModelParameterPlan.js";
import { compileSemanticMotion } from "../src/model-engine/compiler/compileSemanticMotion.js";
import type { CompileOptions } from "../src/model-engine/compiler/contracts.js";
import {
  SCHEMA_MOTION_INTENT_V4,
  SCHEMA_SEMANTIC_AXIS_PROFILE_V3,
  SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
  SCHEMA_VOICE_FOLLOWING_PROFILE_V3,
} from "../src/types/protocol.js";
import type {
  NormalizedSemanticMotionIntentV4,
  SemanticParameterPlan,
} from "../src/types/protocol.js";
import type { SemanticAxisProfile } from "../src/types/semantic-axis-profile.js";
import { makeValidModelSummary } from "./fixtures/modelSyncFixture.js";

const modelId = "speech-pose-test";
const profile: SemanticAxisProfile = {
  schema_version: SCHEMA_SEMANTIC_AXIS_PROFILE_V3,
  profile_id: `${modelId}.semantic.v3`,
  model_id: modelId,
  source_hash: "source-hash",
  last_scanned_hash: "source-hash",
  revision: 1,
  status: "generated",
  user_modified: false,
  generated_at: "",
  updated_at: "",
  axes: [{
    id: "head_yaw",
    label: "Head yaw",
    description: "",
    semantic_group: "head",
    control_role: "primary",
    neutral: 0,
    value_range: [-30, 30],
    soft_range: [-8, 8],
    strong_range: [-20, 20],
    extreme_range: [-30, 30],
    level_anchors: {
      "-4": -30,
      "-3": -22,
      "-2": -15,
      "-1": -8,
      "0": 0,
      "1": 8,
      "2": 15,
      "3": 22,
      "4": 30,
    },
    positive_semantics: [],
    negative_semantics: [],
    usage_notes: "",
    dynamics: {
      max_velocity: 1,
      max_acceleration: 1,
      max_speech_offset_ratio: 0.1,
    },
    parameter_bindings: [{
      parameter_id: "ParamAngleX",
      input_range: [-30, 30],
      output_range: [-30, 30],
      default_weight: 1,
      invert: false,
    }],
  }],
  relation_graph: {
    schema_version: SCHEMA_SEMANTIC_AXIS_RELATION_GRAPH_V1,
    edges: [],
  },
};

const optionsBase = {
  model: makeValidModelSummary({
    name: modelId,
    semantic_axis_profile: profile,
    voice_following_profile: {
      schema_version: SCHEMA_VOICE_FOLLOWING_PROFILE_V3,
      model_id: modelId,
      revision: 1,
      channels: {
        head_yaw: {
          channel: "head_yaw",
          semantic_axis_id: "head_yaw",
          layer: "head",
          amplitude_ratio: 0.3,
          follow_delay_ms: 0,
        },
      },
    },
  }) as unknown as CompileOptions["model"],
  speechActive: true,
  targetDurationMs: 2400,
  assistantText: "Thanks for asking. I can walk through it with you.",
} satisfies Omit<CompileOptions, "samplingIdentity">;

const untaggedIntent: NormalizedSemanticMotionIntentV4 = {
  schema_version: SCHEMA_MOTION_INTENT_V4,
  profile_id: profile.profile_id,
  profile_revision: profile.revision,
  model_id: profile.model_id,
  mode: "idle",
  intent_tags: [],
  emotion_label: "neutral",
  axis_levels: {},
};

function compileGesture(
  intent: NormalizedSemanticMotionIntentV4,
  identity: { turnId: string; messageId: string },
  options: Omit<CompileOptions, "samplingIdentity"> = optionsBase,
): NonNullable<SemanticParameterPlan["parameters"][number]["modulation"]> {
  const semantic = compileSemanticMotion(intent, {
    ...options,
    samplingIdentity: identity,
  });
  if (!semantic.ok) {
    throw new Error(`semantic_compile_failed:${semantic.reason}`);
  }

  const plan = compileModelParameterPlan(semantic.motion, {
    ...options,
    samplingIdentity: identity,
  });
  if (!plan.ok || !plan.plan) {
    throw new Error(`parameter_plan_compile_failed:${plan.reason}`);
  }

  const modulation = plan.plan.parameters.find((parameter) => parameter.modulation)?.modulation;
  assert.ok(modulation);
  return modulation;
}

assert.equal(
  compileGesture(untaggedIntent, { turnId: "turn-1", messageId: "message-1" }).preset,
  "calm_explain",
);
assert.equal(
  compileGesture(untaggedIntent, { turnId: "turn-2", messageId: "message-9" }).preset,
  "calm_explain",
);
assert.equal(
  compileGesture({
    ...untaggedIntent,
    emotion_label: "happy",
    intent_tags: ["happy"],
  }, { turnId: "turn-3", messageId: "message-2" }).preset,
  "lively_chat",
);

const leftGesture = compileGesture({
  ...untaggedIntent,
  axis_levels: { head_yaw: -3 },
}, { turnId: "turn-4", messageId: "message-3" });
const firstLeftGestureValue = leftGesture.points.find((point) => point.value !== 0)?.value;
assert.ok(firstLeftGestureValue !== undefined && firstLeftGestureValue < 0);

const rightGesture = compileGesture({
  ...untaggedIntent,
  axis_levels: { head_yaw: 3 },
}, { turnId: "turn-5", messageId: "message-4" });
const firstRightGestureValue = rightGesture.points.find((point) => point.value !== 0)?.value;
assert.ok(firstRightGestureValue !== undefined && firstRightGestureValue > 0);

const invertedProfile: SemanticAxisProfile = {
  ...profile,
  axes: profile.axes.map((axis) => ({
    ...axis,
    parameter_bindings: axis.parameter_bindings.map((binding) => ({
      ...binding,
      invert: true,
    })),
  })),
};
const invertedOptions: Omit<CompileOptions, "samplingIdentity"> = {
  ...optionsBase,
  model: makeValidModelSummary({
    name: modelId,
    semantic_axis_profile: invertedProfile,
    voice_following_profile: optionsBase.model.voice_following_profile,
  }) as unknown as CompileOptions["model"],
};
const invertedGesture = compileGesture({
  ...untaggedIntent,
  axis_levels: { head_yaw: 3 },
}, { turnId: "turn-6", messageId: "message-5" }, invertedOptions);
const firstInvertedGestureValue = invertedGesture.points
  .find((point) => point.value !== 0)?.value;
assert.ok(firstInvertedGestureValue !== undefined && firstInvertedGestureValue < 0);

const pitchProfile: SemanticAxisProfile = {
  ...profile,
  axes: profile.axes.map((axis) => ({
    ...axis,
    id: "head_pitch",
    parameter_bindings: axis.parameter_bindings.map((binding) => ({
      ...binding,
      parameter_id: "ParamAngleY",
    })),
  })),
};
const pitchOptions: Omit<CompileOptions, "samplingIdentity"> = {
  ...optionsBase,
  model: makeValidModelSummary({
    name: modelId,
    semantic_axis_profile: pitchProfile,
    voice_following_profile: {
      ...optionsBase.model.voice_following_profile,
      channels: {
        head_pitch: {
          channel: "head_pitch",
          semantic_axis_id: "head_pitch",
          layer: "head",
          amplitude_ratio: 0.3,
          follow_delay_ms: 0,
        },
      },
    },
  }) as unknown as CompileOptions["model"],
};
const emphaticPitchGesture = compileGesture({
  ...untaggedIntent,
  emotion_label: "excited",
  intent_tags: ["excited"],
  axis_levels: { head_pitch: 3 },
}, { turnId: "turn-7", messageId: "message-6" }, pitchOptions);
const firstEmphaticPitchValue = emphaticPitchGesture.points
  .find((point) => point.value !== 0)?.value;
assert.ok(firstEmphaticPitchValue !== undefined && firstEmphaticPitchValue > 0);

console.log("speech pose coherence tests passed");
