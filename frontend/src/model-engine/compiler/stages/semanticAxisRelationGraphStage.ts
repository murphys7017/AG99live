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

// This is the sole owner of semantic-axis derivation and constraints. It
// resolves the complete relation graph to a fixed point before any parameter
// bindings are created.
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

  let result: RelationGraphResolution;
  try {
    result = resolveSemanticAxisRelationGraph(
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

  context.state.controlledValues = result.controlledValues;
  context.state.derivedValues = result.derivedValues;
  for (const axisId of Object.keys(result.derivedValues)) {
    context.state.axisValueSources[axisId] = "relation_graph";
  }
  context.state.appliedDerivedAxes = Object.keys(result.derivedValues).sort();
  context.state.relationAdjustments = result.adjustments;
  context.state.relationEvaluations = result.evaluations;
  context.state.warnings = [
    ...context.state.warnings,
    ...result.warnings,
  ];
  refreshAllAxisValues(context.state);
  return { ok: true };
}

interface RelationGraphResolution {
  controlledValues: DynamicAxisValues;
  derivedValues: DynamicAxisValues;
  adjustments: MotionAxisRelationAdjustment[];
  evaluations: MotionAxisRelationEvaluation[];
  warnings: string[];
}

function resolveSemanticAxisRelationGraph(
  initialControlledValues: DynamicAxisValues,
  initialDerivedValues: DynamicAxisValues,
  profile: SemanticAxisProfile,
  axisById: Map<string, SemanticAxisDefinition>,
): RelationGraphResolution {
  const explicitControlledValues = { ...initialControlledValues };
  let previousValues = {
    ...initialControlledValues,
    ...initialDerivedValues,
  };
  const rules = profile.relation_graph.edges;
  const adjustmentByRuleId = new Map<string, MotionAxisRelationAdjustment>();
  const evaluationByRuleId = new Map<string, MotionAxisRelationEvaluation>();
  const warningSet = new Set<string>();
  const maxPasses = Math.max(1, rules.length + 1);

  for (let pass = 0; pass < maxPasses; pass += 1) {
    adjustmentByRuleId.clear();
    evaluationByRuleId.clear();
    warningSet.clear();
    const controlledValues = { ...explicitControlledValues };
    const derivedValues: DynamicAxisValues = {};
    const allValues = { ...controlledValues };
    applyAxisRanges(
      controlledValues,
      derivedValues,
      allValues,
      axisById,
      adjustmentByRuleId,
      evaluationByRuleId,
    );

    for (const rule of rules) {
      const result = rule.kind === "derive"
        ? applyDeriveRule(
            rule,
            controlledValues,
            previousValues,
            derivedValues,
            allValues,
            axisById,
          )
        : applyBoundedRatioRule(
            rule,
            controlledValues,
            previousValues,
            derivedValues,
            allValues,
            axisById,
          );
      evaluationByRuleId.set(rule.id, result.evaluation);
      if (result.adjustment) {
        adjustmentByRuleId.set(result.adjustment.ruleId, result.adjustment);
      }
      if (result.warning) {
        warningSet.add(result.warning);
      }
    }

    applyAxisRanges(
      controlledValues,
      derivedValues,
      allValues,
      axisById,
      adjustmentByRuleId,
      evaluationByRuleId,
    );
    if (dynamicAxisValuesEqual(previousValues, allValues)) {
      return {
        controlledValues,
        derivedValues,
        adjustments: [...adjustmentByRuleId.values()],
        evaluations: [...evaluationByRuleId.values()],
        warnings: [...warningSet],
      };
    }
    previousValues = allValues;
  }

  throw new Error("semantic_axis_relation_resolution_exhausted");
}

interface RelationRuleApplication {
  evaluation: MotionAxisRelationEvaluation;
  adjustment?: MotionAxisRelationAdjustment;
  warning?: string;
}

function applyDeriveRule(
  rule: SemanticAxisRelationRule,
  controlledValues: DynamicAxisValues,
  sourceValues: DynamicAxisValues,
  derivedValues: DynamicAxisValues,
  allValues: DynamicAxisValues,
  axisById: Map<string, SemanticAxisDefinition>,
): RelationRuleApplication {
  const axes = resolveRuleAxes(rule, axisById);
  const sourceValue = sourceValues[rule.source_axis_id];
  if (sourceValue === undefined) {
    return skippedRule(rule, "source_axis_missing");
  }
  if (controlledValues[rule.target_axis_id] !== undefined) {
    return {
      evaluation: {
        ruleId: rule.id,
        kind: "derive",
        status: "skipped",
        sourceAxisId: rule.source_axis_id,
        targetAxisId: rule.target_axis_id,
        sourceValue,
        targetBefore: controlledValues[rule.target_axis_id],
        targetAfter: controlledValues[rule.target_axis_id],
        reason: "explicit_target_owned",
      },
      warning: `semantic_relation_skipped_explicit_target:${rule.id}:${rule.target_axis_id}`,
    };
  }
  const sourceDelta = sourceValue - axes.source.neutral;
  if (Math.abs(sourceDelta) <= rule.deadzone) {
    return skippedRule(rule, "source_within_deadzone", sourceValue);
  }
  return deriveTargetFromRule(
    rule,
    "derive",
    sourceValue,
    sourceDelta,
    axes.target,
    derivedValues,
    allValues,
  );
}

function applyBoundedRatioRule(
  rule: SemanticAxisRelationRule,
  controlledValues: DynamicAxisValues,
  sourceValues: DynamicAxisValues,
  derivedValues: DynamicAxisValues,
  allValues: DynamicAxisValues,
  axisById: Map<string, SemanticAxisDefinition>,
): RelationRuleApplication {
  const axes = resolveRuleAxes(rule, axisById);
  const sourceValue = sourceValues[rule.source_axis_id];
  if (sourceValue === undefined) {
    return skippedRule(rule, "source_axis_missing");
  }
  const sourceDelta = sourceValue - axes.source.neutral;
  const targetValue = allValues[rule.target_axis_id];
  if (targetValue === undefined) {
    if (Math.abs(sourceDelta) <= rule.deadzone) {
      return skippedRule(rule, "source_within_deadzone", sourceValue);
    }
    return deriveTargetFromRule(
      rule,
      "bounded_ratio",
      sourceValue,
      sourceDelta,
      axes.target,
      derivedValues,
      allValues,
    );
  }

  const targetDelta = targetValue - axes.target.neutral;
  const hardCap = resolveHardCap(axes.target, rule.deadzone, rule.max_delta);
  const expectedDirection = rule.mode === "opposite_direction" ? -1 : 1;
  const directionMismatch = sourceDelta !== 0
    && targetDelta !== 0
    && sourceDelta * targetDelta * expectedDirection < 0;
  const limit = directionMismatch
    ? Math.min(
      hardCap * 0.5,
      Math.max(
        rule.deadzone * 0.6,
        Math.abs(sourceDelta) * (rule.scale * 0.35) + rule.deadzone * 0.5,
      ),
    )
    : Math.min(
      hardCap,
      Math.max(rule.deadzone, Math.abs(sourceDelta) * rule.scale + rule.deadzone),
    );
  const constrainedValue = clamp(
    axes.target.neutral + clamp(targetDelta, -limit, limit),
    axes.target.value_range[0],
    axes.target.value_range[1],
  );
  if (Math.abs(constrainedValue - targetValue) <= 0.0001) {
    return {
      evaluation: {
        ruleId: rule.id,
        kind: "bounded_ratio",
        status: "within_limit",
        sourceAxisId: rule.source_axis_id,
        targetAxisId: rule.target_axis_id,
        sourceValue,
        targetBefore: targetValue,
        targetAfter: targetValue,
        limit,
        reason: directionMismatch
          ? "relation_direction_mismatch_within_limit"
          : "relation_expected_direction_within_limit",
      },
    };
  }

  allValues[rule.target_axis_id] = constrainedValue;
  if (controlledValues[rule.target_axis_id] !== undefined) {
    controlledValues[rule.target_axis_id] = constrainedValue;
  } else {
    derivedValues[rule.target_axis_id] = constrainedValue;
  }
  const reason = directionMismatch
    ? "relation_direction_mismatch_limit"
    : "relation_expected_direction_limit";
  return {
    evaluation: {
      ruleId: rule.id,
      kind: "bounded_ratio",
      status: "constrained",
      sourceAxisId: rule.source_axis_id,
      targetAxisId: rule.target_axis_id,
      sourceValue,
      candidateValue: targetValue,
      targetBefore: targetValue,
      targetAfter: constrainedValue,
      limit,
      constraintReasons: [reason],
      reason,
    },
    adjustment: {
      ruleId: rule.id,
      sourceAxisId: rule.source_axis_id,
      targetAxisId: rule.target_axis_id,
      before: targetValue,
      after: constrainedValue,
      reason,
    },
  };
}

function deriveTargetFromRule(
  rule: SemanticAxisRelationRule,
  kind: "derive" | "bounded_ratio",
  sourceValue: number,
  sourceDelta: number,
  targetAxis: SemanticAxisDefinition,
  derivedValues: DynamicAxisValues,
  allValues: DynamicAxisValues,
): RelationRuleApplication {
  const direction = rule.mode === "opposite_direction" ? -1 : 1;
  const rawCandidateValue = targetAxis.neutral + sourceDelta * rule.scale * direction;
  const maxDeltaValue = targetAxis.neutral + clamp(
    rawCandidateValue - targetAxis.neutral,
    -rule.max_delta,
    rule.max_delta,
  );
  const constrainedValue = clamp(
    maxDeltaValue,
    targetAxis.value_range[0],
    targetAxis.value_range[1],
  );
  const constraintReasons: string[] = [];
  if (Math.abs(maxDeltaValue - rawCandidateValue) > 0.0001) {
    constraintReasons.push("max_delta_limit");
  }
  if (Math.abs(constrainedValue - maxDeltaValue) > 0.0001) {
    constraintReasons.push("axis_value_range_limit");
  }
  const previousValue = allValues[rule.target_axis_id];
  allValues[rule.target_axis_id] = constrainedValue;
  derivedValues[rule.target_axis_id] = constrainedValue;
  const reason = constraintReasons.length
    ? `target_axis_derived_${constraintReasons.join("_")}`
    : "target_axis_derived";
  return {
    evaluation: {
      ruleId: rule.id,
      kind,
      status: constraintReasons.length ? "constrained" : "derived",
      sourceAxisId: rule.source_axis_id,
      targetAxisId: rule.target_axis_id,
      sourceValue,
      candidateValue: rawCandidateValue,
      targetBefore: previousValue,
      targetAfter: constrainedValue,
      limit: rule.max_delta,
      constraintReasons: constraintReasons.length ? constraintReasons : undefined,
      reason,
    },
    adjustment: constraintReasons.length
      ? {
          ruleId: rule.id,
          sourceAxisId: rule.source_axis_id,
          targetAxisId: rule.target_axis_id,
          before: rawCandidateValue,
          after: constrainedValue,
          reason,
        }
      : undefined,
  };
}

function applyAxisRanges(
  controlledValues: DynamicAxisValues,
  derivedValues: DynamicAxisValues,
  allValues: DynamicAxisValues,
  axisById: Map<string, SemanticAxisDefinition>,
  adjustmentByRuleId: Map<string, MotionAxisRelationAdjustment>,
  evaluationByRuleId: Map<string, MotionAxisRelationEvaluation>,
): void {
  for (const [axisId, value] of Object.entries(allValues)) {
    const axis = axisById.get(axisId);
    if (!axis) {
      throw new Error(`semantic_axis_relation_axis_missing:range:${axisId}`);
    }
    const ruleId = `axis_value_range:${axisId}`;
    const constrainedValue = clamp(value, axis.value_range[0], axis.value_range[1]);
    if (Math.abs(constrainedValue - value) <= 0.0001) {
      evaluationByRuleId.set(ruleId, {
        ruleId,
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
    if (controlledValues[axisId] !== undefined) {
      controlledValues[axisId] = constrainedValue;
    } else {
      derivedValues[axisId] = constrainedValue;
    }
    adjustmentByRuleId.set(ruleId, {
      ruleId,
      targetAxisId: axisId,
      before: value,
      after: constrainedValue,
      reason: "axis_value_range_limit",
    });
    evaluationByRuleId.set(ruleId, {
      ruleId,
      kind: "axis_range",
      status: "constrained",
      targetAxisId: axisId,
      candidateValue: value,
      targetBefore: value,
      targetAfter: constrainedValue,
      constraintReasons: ["axis_value_range_limit"],
      reason: "axis_value_range_limit",
    });
  }
}

function skippedRule(
  rule: SemanticAxisRelationRule,
  reason: string,
  sourceValue?: number,
): RelationRuleApplication {
  return {
    evaluation: {
      ruleId: rule.id,
      kind: rule.kind,
      status: "skipped",
      sourceAxisId: rule.source_axis_id,
      targetAxisId: rule.target_axis_id,
      sourceValue,
      reason,
    },
  };
}

function resolveRuleAxes(
  rule: SemanticAxisRelationRule,
  axisById: Map<string, SemanticAxisDefinition>,
): { source: SemanticAxisDefinition; target: SemanticAxisDefinition } {
  const source = axisById.get(rule.source_axis_id);
  const target = axisById.get(rule.target_axis_id);
  if (!source || !target) {
    throw new Error(`semantic_axis_relation_axis_missing:${rule.id}`);
  }
  return { source, target };
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

function dynamicAxisValuesEqual(
  left: DynamicAxisValues,
  right: DynamicAxisValues,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue === undefined || rightValue === undefined) {
      if (leftValue !== rightValue) return false;
      continue;
    }
    if (Math.abs(leftValue - rightValue) > 1e-6) return false;
  }
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
