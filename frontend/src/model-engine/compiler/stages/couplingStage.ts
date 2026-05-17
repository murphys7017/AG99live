import type { SemanticAxisDefinition } from "../../../types/semantic-axis-profile.js";
import type {
  DynamicAxisValues,
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
} from "../compileContext.js";
import { mergeDerivedAxisValues, refreshAllAxisValues } from "../compileContext.js";

// Reads:
// - context.state.profile
// - context.state.axisById
// - context.state.controlledValues
// - context.state.warnings
//
// Writes:
// - context.state.derivedValues
// - context.state.allAxisValues
// - context.state.warnings
//
// Does not own:
// - mode resolution
// - timing
// - parameter generation
export const couplingStage: MotionCompileStage = {
  id: "coupling",
  run: runCouplingStage,
};

export function runCouplingStage(
  context: MotionCompileContext,
): MotionStageResult {
  const profile = context.state.profile;
  if (!profile) {
    return { ok: false, reason: "semantic_profile_missing" };
  }

  let couplingResult: { values: DynamicAxisValues; warnings: string[] };
  try {
    couplingResult = applySemanticCouplings(
      context.state.controlledValues,
      profile,
      context.state.axisById,
    );
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error ? error.message : "semantic_coupling_failed",
    };
  }

  if (couplingResult.warnings.length > 0) {
    context.state.warnings = [
      ...context.state.warnings,
      ...couplingResult.warnings,
    ];
    console.warn(
      "[ModelEngine] semantic coupling adjusted:",
      couplingResult.warnings,
    );
  }

  mergeDerivedAxisValues(context.state, couplingResult.values, "coupling");
  refreshAllAxisValues(context.state);

  return { ok: true };
}

function applySemanticCouplings(
  sourceValues: DynamicAxisValues,
  profile: NonNullable<MotionCompileContext["state"]["profile"]>,
  axisById: Map<string, SemanticAxisDefinition>,
): { values: DynamicAxisValues; warnings: string[] } {
  const baseValues: DynamicAxisValues = { ...sourceValues };
  let resolvedValues: DynamicAxisValues = { ...baseValues };
  const result: DynamicAxisValues = {};
  const warningSet = new Set<string>();
  const maxPasses = Math.max(1, profile.couplings.length + 1);

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const nextResolvedValues: DynamicAxisValues = { ...baseValues };
    const nextDerivedValues: DynamicAxisValues = {};

    for (const coupling of profile.couplings) {
      const sourceAxis = axisById.get(coupling.source_axis_id);
      const targetAxis = axisById.get(coupling.target_axis_id);
      if (!sourceAxis || !targetAxis) {
        throw new Error(`semantic_coupling_axis_missing:${coupling.id}`);
      }

      const sourceValue = resolvedValues[coupling.source_axis_id];
      if (sourceValue === undefined) {
        continue;
      }
      if (baseValues[coupling.target_axis_id] !== undefined) {
        warningSet.add(
          `semantic_coupling_skipped_explicit_target:${coupling.id}:${coupling.target_axis_id}`,
        );
        continue;
      }

      const sourceDelta = sourceValue - sourceAxis.neutral;
      if (Math.abs(sourceDelta) <= coupling.deadzone) {
        continue;
      }

      const direction = coupling.mode === "opposite_direction" ? -1 : 1;
      const rawDelta = sourceDelta * coupling.scale * direction;
      const clampedDelta = Math.max(
        -coupling.max_delta,
        Math.min(coupling.max_delta, rawDelta),
      );
      const [minValue, maxValue] = targetAxis.value_range;
      const targetValue = targetAxis.neutral + clampedDelta;
      const clampedTargetValue = Math.max(minValue, Math.min(maxValue, targetValue));

      if (clampedTargetValue !== targetValue) {
        warningSet.add(
          `semantic_coupling_clamped:${coupling.id}:${targetValue}->${clampedTargetValue}`,
        );
      }

      nextResolvedValues[coupling.target_axis_id] = clampedTargetValue;
      nextDerivedValues[coupling.target_axis_id] = clampedTargetValue;
    }

    const changed = !dynamicAxisValuesEqual(resolvedValues, nextResolvedValues);
    if (!changed) {
      return { values: nextDerivedValues, warnings: [...warningSet] };
    }

    resolvedValues = nextResolvedValues;
    Object.keys(result).forEach((axisId) => {
      delete result[axisId];
    });
    Object.assign(result, nextDerivedValues);
  }

  throw new Error("semantic_coupling_resolution_exhausted");
}

function dynamicAxisValuesEqual(
  left: DynamicAxisValues,
  right: DynamicAxisValues,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue === undefined || rightValue === undefined) {
      if (leftValue !== rightValue) {
        return false;
      }
      continue;
    }
    if (Math.abs(leftValue - rightValue) > 1e-6) {
      return false;
    }
  }
  return true;
}
