import type {
  SemanticAxisDefinition,
  SemanticAxisProfile,
  SemanticAxisRelationRule,
} from "../../../types/semantic-axis-profile.js";
import type {
  DynamicAxisValues,
  MotionCompileContext,
  MotionCompileStage,
  MotionStageResult,
} from "../compileContext.js";
import type {
  MotionAxisRelationAdjustment,
  MotionAxisRelationEvaluation,
} from "../contracts.js";
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

  const derivedAxesBefore = new Set(Object.keys(context.state.derivedValues));
  let result: {
    adjustments: MotionAxisRelationAdjustment[];
    evaluations: MotionAxisRelationEvaluation[];
  };
  try {
    result = applyHeadBodyRelations(
      context.state.controlledValues,
      context.state.derivedValues,
      profile,
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

  context.state.relationEvaluations = [
    ...context.state.relationEvaluations,
    ...result.evaluations,
  ];
  for (const adjustment of result.adjustments) {
    context.state.relationAdjustments.push(adjustment);
    context.state.warnings = [
      ...context.state.warnings,
      `semantic_axis_relation_adjusted:${adjustment.ruleId}:${adjustment.targetAxisId}:${adjustment.before}->${adjustment.after}`,
    ];
  }

  for (const axisId of Object.keys(context.state.derivedValues)) {
    if (derivedAxesBefore.has(axisId)) {
      continue;
    }
    context.state.axisValueSources[axisId] = "coupling";
    context.state.appliedDerivedAxes = Array.from(
      new Set([...context.state.appliedDerivedAxes, axisId]),
    );
  }

  refreshAllAxisValues(context.state);
  return { ok: true };
}

function applyHeadBodyRelations(
  controlledValues: DynamicAxisValues,
  derivedValues: DynamicAxisValues,
  profile: SemanticAxisProfile,
  axisById: Map<string, SemanticAxisDefinition>,
): {
  adjustments: MotionAxisRelationAdjustment[];
  evaluations: MotionAxisRelationEvaluation[];
} {
  const adjustments: MotionAxisRelationAdjustment[] = [];
  const evaluationByRuleId = new Map<string, MotionAxisRelationEvaluation>();
  const relationRules: readonly SemanticAxisRelationRule[] =
    profile.relation_graph.edges.filter((edge) => edge.kind === "bounded_ratio");
  const allValues = {
    ...controlledValues,
    ...derivedValues,
  };

  applyAxisValueRangeConstraints(
    controlledValues,
    derivedValues,
    allValues,
    axisById,
    adjustments,
    evaluationByRuleId,
  );

  const maxPasses = Math.max(1, relationRules.length + 1);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;

    for (const rule of relationRules) {
      const sourceValue = allValues[rule.source_axis_id];
      if (sourceValue === undefined) {
        evaluationByRuleId.set(rule.id, {
          ruleId: rule.id,
          kind: "bounded_ratio",
          status: "skipped",
          sourceAxisId: rule.source_axis_id,
          targetAxisId: rule.target_axis_id,
          reason: "source_axis_missing",
        });
        continue;
      }

      const sourceAxis = axisById.get(rule.source_axis_id);
      const targetAxis = axisById.get(rule.target_axis_id);
      if (!sourceAxis || !targetAxis) {
        throw new Error(`semantic_axis_relation_axis_missing:${rule.id}`);
      }

      const sourceDelta = sourceValue - sourceAxis.neutral;
      const targetValue = allValues[rule.target_axis_id];
      if (targetValue === undefined) {
        if (Math.abs(sourceDelta) <= rule.deadzone) {
          evaluationByRuleId.set(rule.id, {
            ruleId: rule.id,
            kind: "bounded_ratio",
            status: "skipped",
            sourceAxisId: rule.source_axis_id,
            targetAxisId: rule.target_axis_id,
            sourceValue,
            reason: "source_within_deadzone",
          });
          continue;
        }
        const direction = rule.mode === "opposite_direction" ? -1 : 1;
        const derivedDelta = clamp(
          sourceDelta * rule.scale * direction,
          -rule.max_delta,
          rule.max_delta,
        );
        const derivedValue = clamp(
          targetAxis.neutral + derivedDelta,
          targetAxis.value_range[0],
          targetAxis.value_range[1],
        );
        allValues[rule.target_axis_id] = derivedValue;
        derivedValues[rule.target_axis_id] = derivedValue;
        evaluationByRuleId.set(rule.id, {
          ruleId: rule.id,
          kind: "bounded_ratio",
          status: "derived",
          sourceAxisId: rule.source_axis_id,
          targetAxisId: rule.target_axis_id,
          sourceValue,
          targetAfter: derivedValue,
          limit: rule.max_delta,
          reason: "target_axis_derived",
        });
        changed = true;
        continue;
      }

      const targetDelta = targetValue - targetAxis.neutral;
      const hardCap = resolveHardCap(targetAxis, rule.deadzone, rule.max_delta);
      const opposite = sourceDelta !== 0
        && targetDelta !== 0
        && sourceDelta * targetDelta < 0;
      const limit = opposite
        ? Math.min(
          hardCap * 0.5,
          Math.max(
            rule.deadzone * 0.6,
            Math.abs(sourceDelta) * (rule.scale * 0.35)
              + rule.deadzone * 0.5,
          ),
        )
        : Math.min(
          hardCap,
          Math.max(
            rule.deadzone,
            Math.abs(sourceDelta) * rule.scale + rule.deadzone,
          ),
        );
      const constrainedDelta = clamp(targetDelta, -limit, limit);
      const constrainedValue = clamp(
        targetAxis.neutral + constrainedDelta,
        targetAxis.value_range[0],
        targetAxis.value_range[1],
      );

      if (Math.abs(constrainedValue - targetValue) <= 0.0001) {
        recordRelationEvaluation(evaluationByRuleId, {
          ruleId: rule.id,
          kind: "bounded_ratio",
          status: "within_limit",
          sourceAxisId: rule.source_axis_id,
          targetAxisId: rule.target_axis_id,
          sourceValue,
          targetBefore: targetValue,
          targetAfter: targetValue,
          limit,
          reason: opposite ? "opposite_direction_within_limit" : "follow_direction_within_limit",
        });
        continue;
      }

      allValues[rule.target_axis_id] = constrainedValue;
      if (Object.prototype.hasOwnProperty.call(controlledValues, rule.target_axis_id)) {
        controlledValues[rule.target_axis_id] = constrainedValue;
      } else {
        derivedValues[rule.target_axis_id] = constrainedValue;
      }
      changed = true;
      adjustments.push({
        ruleId: rule.id,
        sourceAxisId: rule.source_axis_id,
        targetAxisId: rule.target_axis_id,
        before: targetValue,
        after: constrainedValue,
        reason: opposite ? "opposite_direction_limit" : "follow_direction_limit",
      });
      evaluationByRuleId.set(rule.id, {
        ruleId: rule.id,
        kind: "bounded_ratio",
        status: "constrained",
        sourceAxisId: rule.source_axis_id,
        targetAxisId: rule.target_axis_id,
        sourceValue,
        targetBefore: targetValue,
        targetAfter: constrainedValue,
        limit,
        reason: opposite ? "opposite_direction_limit" : "follow_direction_limit",
      });
    }

    if (!changed) {
      return {
        adjustments,
        evaluations: [...evaluationByRuleId.values()],
      };
    }
  }

  throw new Error("semantic_axis_relation_resolution_exhausted");
}

function applyAxisValueRangeConstraints(
  controlledValues: DynamicAxisValues,
  derivedValues: DynamicAxisValues,
  allValues: DynamicAxisValues,
  axisById: Map<string, SemanticAxisDefinition>,
  adjustments: MotionAxisRelationAdjustment[],
  evaluationByRuleId: Map<string, MotionAxisRelationEvaluation>,
): void {
  for (const [axisId, value] of Object.entries(allValues)) {
    const axis = axisById.get(axisId);
    if (!axis) {
      throw new Error(`semantic_axis_relation_axis_missing:range:${axisId}`);
    }

    const constrainedValue = clamp(
      value,
      axis.value_range[0],
      axis.value_range[1],
    );
    if (Math.abs(constrainedValue - value) <= 0.0001) {
      evaluationByRuleId.set(`axis_value_range:${axisId}`, {
        ruleId: `axis_value_range:${axisId}`,
        kind: "axis_range",
        status: "within_limit",
        targetAxisId: axisId,
        targetBefore: value,
        targetAfter: value,
        reason: "axis_value_within_range",
      });
      continue;
    }

    allValues[axisId] = constrainedValue;
    if (Object.prototype.hasOwnProperty.call(controlledValues, axisId)) {
      controlledValues[axisId] = constrainedValue;
    } else {
      derivedValues[axisId] = constrainedValue;
    }
    adjustments.push({
      ruleId: `axis_value_range:${axisId}`,
      targetAxisId: axisId,
      before: value,
      after: constrainedValue,
      reason: "axis_value_range_limit",
    });
    evaluationByRuleId.set(`axis_value_range:${axisId}`, {
      ruleId: `axis_value_range:${axisId}`,
      kind: "axis_range",
      status: "constrained",
      targetAxisId: axisId,
      targetBefore: value,
      targetAfter: constrainedValue,
      reason: "axis_value_range_limit",
    });
  }
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

function recordRelationEvaluation(
  evaluations: Map<string, MotionAxisRelationEvaluation>,
  next: MotionAxisRelationEvaluation,
): void {
  const previous = evaluations.get(next.ruleId);
  if (
    next.status === "within_limit"
    && (previous?.status === "derived" || previous?.status === "constrained")
  ) {
    return;
  }
  evaluations.set(next.ruleId, next);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
