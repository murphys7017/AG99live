import type { SemanticAxisCoupling, SemanticAxisDefinition } from "../../../types/semantic-axis-profile.js";
import type {
  DynamicAxisValues,
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
} from "../compileContext.js";
import type { MotionAxisRelationAdjustment } from "../contracts.js";
import { refreshAllAxisValues } from "../compileContext.js";

// This stage is the single owner of semantic axis relations. Candidate stages
// may propose values, but only this stage may constrain the final axis vector.
export const semanticAxisRelationGraphStage: MotionCompileStage = {
  id: "semanticAxisRelationGraph",
  run: runSemanticAxisRelationGraphStage,
};

export function runSemanticAxisRelationGraphStage(
  context: MotionCompileContext,
): MotionStageResult {
  const profile = context.state.profile;
  if (!profile) {
    return { ok: false, reason: "semantic_profile_missing" };
  }

  let adjustments: MotionAxisRelationAdjustment[];
  try {
    adjustments = applyHeadBodyRelations(
      context.state.controlledValues,
      context.state.derivedValues,
      profile.couplings,
      context.state.axisById,
    );
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error
        ? error.message
        : "semantic_axis_relation_graph_failed",
    };
  }

  for (const adjustment of adjustments) {
    context.state.relationAdjustments.push(adjustment);
    context.state.warnings = [
      ...context.state.warnings,
      `semantic_axis_relation_adjusted:${adjustment.ruleId}:${adjustment.targetAxisId}:${adjustment.before}->${adjustment.after}`,
    ];
  }

  refreshAllAxisValues(context.state);
  return { ok: true };
}

function applyHeadBodyRelations(
  controlledValues: DynamicAxisValues,
  derivedValues: DynamicAxisValues,
  couplings: readonly SemanticAxisCoupling[],
  axisById: Map<string, SemanticAxisDefinition>,
): MotionAxisRelationAdjustment[] {
  const adjustments: MotionAxisRelationAdjustment[] = [];
  const allValues = {
    ...controlledValues,
    ...derivedValues,
  };

  for (const coupling of couplings) {
    if (
      !coupling.source_axis_id.startsWith("head_")
      || !coupling.target_axis_id.startsWith("body_")
    ) {
      continue;
    }

    const sourceValue = allValues[coupling.source_axis_id];
    const targetValue = allValues[coupling.target_axis_id];
    if (sourceValue === undefined || targetValue === undefined) {
      continue;
    }

    const sourceAxis = axisById.get(coupling.source_axis_id);
    const targetAxis = axisById.get(coupling.target_axis_id);
    if (!sourceAxis || !targetAxis) {
      throw new Error(`semantic_axis_relation_axis_missing:${coupling.id}`);
    }

    const sourceDelta = sourceValue - sourceAxis.neutral;
    const targetDelta = targetValue - targetAxis.neutral;
    const hardCap = resolveHardCap(targetAxis, coupling.deadzone, coupling.max_delta);
    const opposite = sourceDelta !== 0
      && targetDelta !== 0
      && sourceDelta * targetDelta < 0;
    const limit = opposite
      ? Math.min(
        hardCap * 0.5,
        Math.max(
          coupling.deadzone * 0.6,
          Math.abs(sourceDelta) * (coupling.scale * 0.35)
            + coupling.deadzone * 0.5,
        ),
      )
      : Math.min(
        hardCap,
        Math.max(
          coupling.deadzone,
          Math.abs(sourceDelta) * coupling.scale + coupling.deadzone,
        ),
      );
    const constrainedDelta = clamp(targetDelta, -limit, limit);
    const constrainedValue = clamp(
      targetAxis.neutral + constrainedDelta,
      targetAxis.value_range[0],
      targetAxis.value_range[1],
    );

    if (Math.abs(constrainedValue - targetValue) <= 0.0001) {
      continue;
    }

    allValues[coupling.target_axis_id] = constrainedValue;
    if (Object.prototype.hasOwnProperty.call(controlledValues, coupling.target_axis_id)) {
      controlledValues[coupling.target_axis_id] = constrainedValue;
    } else {
      derivedValues[coupling.target_axis_id] = constrainedValue;
    }
    adjustments.push({
      ruleId: coupling.id,
      sourceAxisId: coupling.source_axis_id,
      targetAxisId: coupling.target_axis_id,
      before: targetValue,
      after: constrainedValue,
      reason: opposite ? "opposite_direction_limit" : "follow_direction_limit",
    });
  }

  return adjustments;
}

function resolveHardCap(
  axis: SemanticAxisDefinition,
  deadzone: number,
  maxDelta: number,
): number {
  const strongHalfSpan = Math.max(
    Math.abs(axis.strong_range[1] - axis.neutral),
    Math.abs(axis.neutral - axis.strong_range[0]),
  );
  return Math.max(maxDelta, strongHalfSpan + Math.min(deadzone, 6));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
