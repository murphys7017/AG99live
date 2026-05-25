import type { SemanticAxisDefinition } from "../../../types/semantic-axis-profile.js";
import type {
  DynamicAxisValues,
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
} from "../compileContext.js";
import { mergeDerivedAxisValues, refreshAllAxisValues } from "../compileContext.js";

const SPEECH_POSE_GROUPS = new Set(["head", "body", "torso", "shoulder"]);
const SPEECH_POSE_KEYWORDS = [
  "speech",
  "speaking",
  "talk",
  "voice",
  "vocal",
  "说话",
  "讲话",
  "发声",
];

// Reads:
// - context.options.speechActive
// - context.state.profile
// - context.state.axisById
// - context.state.controlledValues
// - context.state.derivedValues
// - context.state.allAxisValues
// - context.state.warnings
//
// Writes:
// - context.state.derivedValues
// - context.state.axisValueSources
// - context.state.appliedDerivedAxes
// - context.state.allAxisValues
// - context.state.warnings
//
// Does not own:
// - controlled axis values
// - mode resolution
// - timing
// - parameter generation
export const speechPoseStage: MotionCompileStage = {
  id: "speechPose",
  run: runSpeechPoseStage,
};

export function runSpeechPoseStage(
  context: MotionCompileContext,
): MotionStageResult {
  if (context.options.speechActive !== true) {
    return { ok: true };
  }

  const profile = context.state.profile;
  if (!profile) {
    return { ok: false, reason: "semantic_profile_missing" };
  }

  const candidateAxes = selectSpeechPoseAxes(context);
  if (!candidateAxes.length) {
    context.state.warnings = [
      ...context.state.warnings,
      "speech_pose_skipped_no_candidate_axis",
    ];
    return { ok: true };
  }

  const values = buildSpeechPoseValues(candidateAxes, context);
  const axisIds = Object.keys(values);
  if (!axisIds.length) {
    return { ok: true };
  }

  mergeDerivedAxisValues(context.state, values, "speech_pose");
  refreshAllAxisValues(context.state);
  context.state.warnings = [
    ...context.state.warnings,
    ...axisIds.map((axisId) => `speech_pose_applied:${axisId}`),
  ];

  return { ok: true };
}

function selectSpeechPoseAxes(
  context: MotionCompileContext,
): SemanticAxisDefinition[] {
  const profile = context.state.profile;
  if (!profile) {
    return [];
  }

  const axes: SemanticAxisDefinition[] = [];
  for (const axis of profile.axes) {
    if (!isDedicatedSpeechPoseAxis(axis)) {
      continue;
    }
    if (context.state.controlledValues[axis.id] !== undefined) {
      context.state.warnings = [
        ...context.state.warnings,
        `speech_pose_skipped_existing_axis:${axis.id}`,
      ];
      continue;
    }
    if (context.state.derivedValues[axis.id] !== undefined) {
      context.state.warnings = [
        ...context.state.warnings,
        `speech_pose_skipped_existing_axis:${axis.id}`,
      ];
      continue;
    }
    axes.push(axis);
  }
  return axes;
}

function isDedicatedSpeechPoseAxis(axis: SemanticAxisDefinition): boolean {
  if (axis.control_role !== "derived") {
    return false;
  }
  if (!SPEECH_POSE_GROUPS.has(axis.semantic_group)) {
    return false;
  }

  const haystack = [
    axis.id,
    axis.label,
    axis.description,
    axis.usage_notes,
    ...axis.positive_semantics,
    ...axis.negative_semantics,
  ].join(" ").toLowerCase();

  return SPEECH_POSE_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function buildSpeechPoseValues(
  axes: SemanticAxisDefinition[],
  context: MotionCompileContext,
): DynamicAxisValues {
  const values: DynamicAxisValues = {};
  for (const axis of axes) {
    values[axis.id] = resolveSpeechPoseValue(axis, context);
  }
  return values;
}

function resolveSpeechPoseValue(
  axis: SemanticAxisDefinition,
  context: MotionCompileContext,
): number {
  const baseValue = context.state.allAxisValues[axis.id] ?? axis.neutral;
  const [minValue, maxValue] = axis.value_range;
  const [minStrong, maxStrong] = axis.strong_range;
  const positiveRoom = Math.max(0, maxStrong - axis.neutral);
  const negativeRoom = Math.max(0, axis.neutral - minStrong);
  const direction = stableAxisDirection(axis.id);
  const signedRoom = direction >= 0 ? positiveRoom : negativeRoom;
  const delta = signedRoom > 0 ? Math.max(2, signedRoom * 0.45) : 4;
  const targetValue = baseValue + direction * delta;

  return Math.max(minValue, Math.min(maxValue, targetValue));
}

function stableAxisDirection(axisId: string): 1 | -1 {
  let hash = 0;
  for (let index = 0; index < axisId.length; index += 1) {
    hash = (hash + axisId.charCodeAt(index)) % 2;
  }
  return hash === 0 ? 1 : -1;
}
