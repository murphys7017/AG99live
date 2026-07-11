import type {
  SemanticAxisDefinition,
  SemanticAxisProfile,
} from "../../../types/semantic-axis-profile.js";
import type {
  DynamicAxisValues,
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
  ResolvedAxisRoleBuckets,
} from "../compileContext.js";
import type { MotionAxisLevel } from "../../../types/protocol.js";
import { replaceControlledAxisValues } from "../compileContext.js";

const ALLOWED_LLM_ROLES = new Set(["primary", "hint"]);

// Reads:
// - context.intent.axes / context.intent.axis_levels
// - context.state.profile
// - context.state.axisById
//
// Writes:
// - context.state.roleAxisIds
// - context.state.controlledValues
// - context.state.missingAxes
// - context.state.forbiddenAxes
// - context.state.invalidAxes
// - context.state.axisErrorCount
// - context.state.axisErrorLimit
// - context.state.warnings
//
// Does not own:
// - intensity scaling
// - coupling
// - mode resolution
// - timing
// - parameter generation
export const axisResolverStage: MotionCompileStage = {
  id: "axisResolver",
  run: runAxisResolver,
};

export function runAxisResolver(
  context: MotionCompileContext,
): MotionStageResult {
  const profile = context.state.profile;
  if (!profile) {
    return { ok: false, reason: "semantic_profile_missing" };
  }

  const roleAxisIds = buildRoleAxisBuckets(profile);
  const resolvedAxes = resolveAllowedLlmAxisValues(context);
  const missingAxes = collectMissingPrimaryAxes(
    profile,
    resolvedAxes.controlledValues,
    resolvedAxes.warnings,
  );
  const axisErrorCount =
    resolvedAxes.invalidAxes.length + resolvedAxes.forbiddenAxes.length;

  context.state.roleAxisIds = roleAxisIds;
  replaceControlledAxisValues(context.state, resolvedAxes.controlledValues);
  context.state.missingAxes = missingAxes;
  context.state.forbiddenAxes = resolvedAxes.forbiddenAxes;
  context.state.invalidAxes = resolvedAxes.invalidAxes;
  context.state.axisErrorCount = axisErrorCount;
  context.state.axisErrorLimit = 0;
  context.state.warnings = [
    ...context.state.warnings,
    ...resolvedAxes.warnings,
  ];
  if (axisErrorCount > 0) {
    console.error("[ModelEngine] semantic axis validation failed.", {
      invalidAxes: resolvedAxes.invalidAxes,
      missingAxes,
      forbiddenAxes: resolvedAxes.forbiddenAxes,
      axisErrorCount,
    });
    return {
      ok: false,
      reason: `semantic_axis_validation_failed:${[...resolvedAxes.invalidAxes, ...resolvedAxes.forbiddenAxes].join(",")}`,
    };
  }

  if (
    resolveInputAxisIds(context).length > 0
    && Object.keys(resolvedAxes.controlledValues).length > 0
    && Object.entries(resolvedAxes.controlledValues).every(([axisId, value]) => {
      const axis = context.state.axisById.get(axisId);
      return axis
        ? Math.abs(value - axis.neutral) <= 0.001
        : false;
    })
  ) {
    return { ok: false, reason: "semantic_axes_all_neutral" };
  }

  return { ok: true };
}

function buildRoleAxisBuckets(
  profile: SemanticAxisProfile,
): ResolvedAxisRoleBuckets {
  return {
    primaryAxes: profile.axes
      .filter((axis) => axis.control_role === "primary")
      .map((axis) => axis.id),
    hintAxes: profile.axes
      .filter((axis) => axis.control_role === "hint")
      .map((axis) => axis.id),
    derivedAxes: profile.axes
      .filter((axis) => axis.control_role === "derived")
      .map((axis) => axis.id),
    runtimeAxes: profile.axes
      .filter(
        (axis) =>
          axis.control_role === "runtime"
          || axis.control_role === "ambient"
          || axis.control_role === "debug",
      )
      .map((axis) => axis.id),
  };
}

function resolveAllowedLlmAxisValues(
  context: MotionCompileContext,
): {
  controlledValues: DynamicAxisValues;
  warnings: string[];
  forbiddenAxes: string[];
  invalidAxes: string[];
} {
  const controlledValues: DynamicAxisValues = {};
  const warnings: string[] = [];
  const forbiddenAxes: string[] = [];
  const invalidAxes: string[] = [];
  const isLevelIntent = context.intent.schema_version === "engine.motion_intent.v4";
  const inputEntries = context.intent.schema_version === "engine.motion_intent.v4"
    ? Object.entries(context.intent.axis_levels)
    : Object.entries(context.intent.axes);
  console.debug("[ModelEngine] received semantic axis payload.", {
    axisIds: inputEntries.map(([axisId]) => axisId),
    axes: context.intent.schema_version === "engine.motion_intent.v3"
      ? context.intent.axes
      : undefined,
    axisLevels: context.intent.schema_version === "engine.motion_intent.v4"
      ? context.intent.axis_levels
      : undefined,
  });

  for (const [axisId, rawValue] of inputEntries) {
    const axis = context.state.axisById.get(axisId);
    if (!axis) {
      invalidAxes.push(axisId);
      warnings.push(`semantic_axis_ignored_unknown:${axisId}`);
      continue;
    }
    if (!ALLOWED_LLM_ROLES.has(axis.control_role)) {
      forbiddenAxes.push(axisId);
      warnings.push(
        `semantic_axis_ignored_forbidden_role:${axisId}:${axis.control_role}`,
      );
      continue;
    }
    const levelResult = isLevelIntent
      ? resolveAxisLevelValue(axis, rawValue as MotionAxisLevel)
      : null;
    if (levelResult && !levelResult.ok) {
      invalidAxes.push(axisId);
      warnings.push(levelResult.reason);
      continue;
    }
    const value = levelResult?.value ?? rawValue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      invalidAxes.push(axisId);
      warnings.push(`semantic_axis_ignored_not_number:${axisId}`);
      continue;
    }

    const rangeResult = normalizeSemanticAxisValue(axis, value);
    if (rangeResult.warning) {
      warnings.push(rangeResult.warning);
      console.error("[ModelEngine] semantic axis value rejected:", rangeResult.warning);
    }
    if (!rangeResult.ok) {
      invalidAxes.push(axisId);
      continue;
    }
    controlledValues[axisId] = rangeResult.value;
  }

  return {
    controlledValues,
    warnings,
    forbiddenAxes,
    invalidAxes,
  };
}

function resolveInputAxisIds(context: MotionCompileContext): string[] {
  return context.intent.schema_version === "engine.motion_intent.v4"
    ? Object.keys(context.intent.axis_levels)
    : Object.keys(context.intent.axes);
}

function resolveAxisLevelValue(
  axis: SemanticAxisDefinition,
  level: MotionAxisLevel,
): { ok: true; value: number } | { ok: false; reason: string } {
  const anchoredValue = axis.level_anchors?.[String(level)];
  if (typeof anchoredValue !== "number" || !Number.isFinite(anchoredValue)) {
    return {
      ok: false,
      reason: `semantic_axis_level_anchor_missing:${axis.id}:${level}`,
    };
  }
  return { ok: true, value: anchoredValue };
}

function collectMissingPrimaryAxes(
  profile: SemanticAxisProfile,
  controlledValues: DynamicAxisValues,
  warnings: string[],
): string[] {
  const missingAxes: string[] = [];
  for (const axis of profile.axes) {
    if (axis.control_role !== "primary" || axis.id in controlledValues) {
      continue;
    }
    missingAxes.push(axis.id);
    warnings.push(`semantic_primary_axis_missing_ignored:${axis.id}`);
  }
  return missingAxes;
}

function normalizeSemanticAxisValue(
  axis: SemanticAxisDefinition,
  value: number,
): { ok: boolean; value: number; warning: string } {
  const [minValue, maxValue] = axis.value_range;
  if (value < minValue || value > maxValue) {
    return {
      ok: false,
      value,
      warning: `semantic_axis_value_out_of_range:${axis.id}:${value}`,
    };
  }
  return { ok: true, value, warning: "" };
}
