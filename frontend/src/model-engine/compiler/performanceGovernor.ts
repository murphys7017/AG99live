import type {
  CompiledSemanticAxis,
  CompiledSemanticMotion,
  CompiledSemanticMotionStep,
  PerformanceCompositionDirection,
} from "../../types/compiledSemanticMotion.js";
import type { MotionPlanPayload } from "../../types/protocol.js";

const GOVERNOR_VERSION = "performance_governor.v1" as const;
const ACTIVE_AXIS_THRESHOLD = 0.08;
const DEFAULT_MAX_ACTIVE_AXES = 8;
const DEFAULT_MAX_SEQUENCE_STEPS = 4;
const DEFAULT_REPEAT_DIRECTION_ATTENUATION = 0.68;
const MIN_REPEAT_DIRECTION_ATTENUATION = 0.5;

export interface PerformanceBudget {
  readonly maxActiveAxes: number;
  readonly maxSequenceSteps: number;
  readonly repeatDirectionAttenuation: number;
}

export interface ContinuityAxisState {
  readonly value: number;
  readonly neutralValue: number;
  readonly direction: PerformanceCompositionDirection;
}

/**
 * Internal handoff state between two parameter plans. It never crosses the
 * adapter, prompt, Live2D, or C++ boundaries.
 */
export interface ContinuityEnvelope {
  readonly version: "continuity_envelope.v1";
  readonly runId: string;
  readonly origin: string;
  readonly turnId: string | null;
  readonly messageId: string;
  readonly activeAxes: Readonly<Record<string, ContinuityAxisState>>;
  readonly activeParameterIds: readonly string[];
  readonly blendOutMs: number;
}

export interface PerformanceGovernorDiagnostics {
  readonly version: typeof GOVERNOR_VERSION;
  readonly budget: PerformanceBudget;
  readonly truncatedAxisIds: readonly string[];
  readonly truncatedStepCount: number;
  readonly repeatedDirectionAxisIds: readonly string[];
  readonly warnings: readonly string[];
}

export interface GovernedSemanticMotion {
  readonly motion: CompiledSemanticMotion;
  readonly diagnostics: PerformanceGovernorDiagnostics;
}

function resolveDirection(
  value: number,
  neutralValue: number,
): PerformanceCompositionDirection {
  const delta = value - neutralValue;
  if (delta > ACTIVE_AXIS_THRESHOLD) return "positive";
  if (delta < -ACTIVE_AXIS_THRESHOLD) return "negative";
  return "neutral";
}

function axisStrength(axis: CompiledSemanticAxis): number {
  return Math.abs(axis.value - axis.neutralValue);
}

function clampAxisValue(axis: CompiledSemanticAxis, value: number): CompiledSemanticAxis {
  return {
    ...axis,
    value: Number.isFinite(value) ? value : axis.value,
  };
}

function attenuateAxis(
  axis: CompiledSemanticAxis,
  attenuation: number,
): CompiledSemanticAxis {
  return clampAxisValue(
    axis,
    axis.neutralValue + (axis.value - axis.neutralValue) * attenuation,
  );
}

function selectBudgetedAxes(
  axes: readonly CompiledSemanticAxis[],
  maxActiveAxes: number,
  truncatedAxisIds: string[],
): CompiledSemanticAxis[] {
  const active = axes.filter((axis) => axisStrength(axis) >= ACTIVE_AXIS_THRESHOLD);
  if (active.length <= maxActiveAxes) {
    return [...axes];
  }
  const retained = new Set(
    [...active]
      .sort((left, right) => axisStrength(right) - axisStrength(left)
        || left.axisId.localeCompare(right.axisId))
      .slice(0, maxActiveAxes)
      .map((axis) => axis.axisId),
  );
  for (const axis of active) {
    if (!retained.has(axis.axisId)) {
      truncatedAxisIds.push(axis.axisId);
    }
  }
  return axes.filter((axis) => retained.has(axis.axisId));
}

function governAxes(
  axes: readonly CompiledSemanticAxis[],
  previousDirections: ReadonlyMap<string, PerformanceCompositionDirection>,
  repeatCounts: Map<string, number>,
  budget: PerformanceBudget,
  truncatedAxisIds: string[],
  repeatedDirectionAxisIds: string[],
): CompiledSemanticAxis[] {
  const selected = selectBudgetedAxes(axes, budget.maxActiveAxes, truncatedAxisIds);
  return selected.map((axis) => {
    const direction = resolveDirection(axis.value, axis.neutralValue);
    const previousDirection = previousDirections.get(axis.axisId);
    if (
      direction === "neutral"
      || previousDirection !== direction
      || previousDirection === "mixed"
    ) {
      repeatCounts.set(axis.axisId, direction === "neutral" ? 0 : 1);
      return axis;
    }
    const repeatCount = (repeatCounts.get(axis.axisId) ?? 1) + 1;
    repeatCounts.set(axis.axisId, repeatCount);
    repeatedDirectionAxisIds.push(axis.axisId);
    const attenuation = Math.max(
      MIN_REPEAT_DIRECTION_ATTENUATION,
      Math.pow(budget.repeatDirectionAttenuation, Math.min(repeatCount - 1, 3)),
    );
    return attenuateAxis(axis, attenuation);
  });
}

function axisDirections(
  axes: readonly CompiledSemanticAxis[],
): Map<string, PerformanceCompositionDirection> {
  return new Map(
    axes.map((axis) => [
      axis.axisId,
      resolveDirection(axis.value, axis.neutralValue),
    ]),
  );
}

function governStep(
  step: CompiledSemanticMotionStep,
  previousDirections: ReadonlyMap<string, PerformanceCompositionDirection>,
  repeatCounts: Map<string, number>,
  budget: PerformanceBudget,
  truncatedAxisIds: string[],
  repeatedDirectionAxisIds: string[],
): CompiledSemanticMotionStep {
  const axes = governAxes(
    step.axes,
    previousDirections,
    repeatCounts,
    budget,
    truncatedAxisIds,
    repeatedDirectionAxisIds,
  );
  return { ...step, axes };
}

function appendWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

export class PerformanceGovernor {
  readonly budget: PerformanceBudget;

  constructor(budget: Partial<PerformanceBudget> = {}) {
    this.budget = {
      maxActiveAxes: Math.max(1, Math.floor(budget.maxActiveAxes ?? DEFAULT_MAX_ACTIVE_AXES)),
      maxSequenceSteps: Math.max(1, Math.floor(budget.maxSequenceSteps ?? DEFAULT_MAX_SEQUENCE_STEPS)),
      repeatDirectionAttenuation: Math.max(
        MIN_REPEAT_DIRECTION_ATTENUATION,
        Math.min(1, budget.repeatDirectionAttenuation ?? DEFAULT_REPEAT_DIRECTION_ATTENUATION),
      ),
    };
  }

  govern(
    motion: CompiledSemanticMotion,
    envelope: ContinuityEnvelope | null = null,
  ): GovernedSemanticMotion {
    const truncatedAxisIds: string[] = [];
    const repeatedDirectionAxisIds: string[] = [];
    const warnings: string[] = [];
    const repeatCounts = new Map<string, number>();
    const previousDirections = new Map<string, PerformanceCompositionDirection>(
      Object.entries(envelope?.activeAxes ?? {}).map(([axisId, state]) => [
        axisId,
        state.direction,
      ]),
    );

    let governedMotion = motion;
    if (motion.kind === "pose") {
      governedMotion = {
        ...motion,
        axes: governAxes(
          motion.axes,
          previousDirections,
          repeatCounts,
          this.budget,
          truncatedAxisIds,
          repeatedDirectionAxisIds,
        ),
      };
    } else {
      const sourceSteps = motion.steps.slice(0, this.budget.maxSequenceSteps);
      const truncatedStepCount = motion.steps.length - sourceSteps.length;
      if (truncatedStepCount > 0) {
        appendWarning(warnings, `performance_budget_steps_truncated:${truncatedStepCount}`);
      }
      const steps: CompiledSemanticMotionStep[] = [];
      let directions = previousDirections;
      for (const step of sourceSteps) {
        const governedStep = governStep(
          step,
          directions,
          repeatCounts,
          this.budget,
          truncatedAxisIds,
          repeatedDirectionAxisIds,
        );
        steps.push(governedStep);
        directions = axisDirections(governedStep.axes);
      }
      governedMotion = { ...motion, steps };
    }

    if (truncatedAxisIds.length > 0) {
      appendWarning(
        warnings,
        `performance_budget_axes_truncated:${[...new Set(truncatedAxisIds)].length}`,
      );
    }
    if (repeatedDirectionAxisIds.length > 0) {
      appendWarning(
        warnings,
        `performance_repeat_direction_suppressed:${[...new Set(repeatedDirectionAxisIds)].length}`,
      );
    }
    const diagnostics: PerformanceGovernorDiagnostics = {
      version: GOVERNOR_VERSION,
      budget: this.budget,
      truncatedAxisIds: [...new Set(truncatedAxisIds)].sort(),
      truncatedStepCount: motion.kind === "sequence"
        ? Math.max(0, motion.steps.length - this.budget.maxSequenceSteps)
        : 0,
      repeatedDirectionAxisIds: [...new Set(repeatedDirectionAxisIds)].sort(),
      warnings,
    };
    return {
      motion: warnings.length === 0
        ? governedMotion
        : {
            ...governedMotion,
            diagnostics: {
              ...governedMotion.diagnostics,
              warnings: [
                ...(governedMotion.diagnostics.warnings ?? []),
                ...warnings,
              ],
            },
          },
      diagnostics,
    };
  }
}

export const performanceGovernor = new PerformanceGovernor();

export function createContinuityEnvelope(input: {
  runId: string;
  origin: string;
  turnId: string | null;
  messageId: string;
  semanticMotion: CompiledSemanticMotion;
  plan: MotionPlanPayload;
}): ContinuityEnvelope {
  const axes = input.semanticMotion.kind === "sequence"
    ? input.semanticMotion.steps[input.semanticMotion.steps.length - 1]?.axes ?? []
    : input.semanticMotion.axes;
  return {
    version: "continuity_envelope.v1",
    runId: input.runId,
    origin: input.origin,
    turnId: input.turnId,
    messageId: input.messageId,
    activeAxes: Object.fromEntries(
      axes.map((axis) => [axis.axisId, {
        value: axis.value,
        neutralValue: axis.neutralValue,
        direction: resolveDirection(axis.value, axis.neutralValue),
      }]),
    ),
    activeParameterIds: input.plan.parameters.map((parameter) => parameter.parameter_id),
    blendOutMs: input.plan.timing.blend_out_ms,
  };
}

export function mergeContinuityHandoff(
  previousPlan: MotionPlanPayload,
  nextPlan: MotionPlanPayload,
): MotionPlanPayload {
  if (
    previousPlan.profile_id !== nextPlan.profile_id
    || previousPlan.profile_revision !== nextPlan.profile_revision
    || previousPlan.model_id !== nextPlan.model_id
  ) {
    return nextPlan;
  }
  const owned = new Set(nextPlan.parameters.map((parameter) => parameter.parameter_id));
  const release = previousPlan.parameters
    .filter((parameter) => !owned.has(parameter.parameter_id))
    .map((parameter) => {
      const { keyframes, modulation, input_value, ...binding } = parameter;
      return {
        ...binding,
        source: "continuity" as const,
        activation_at_ms: 0,
        target_value: parameter.neutral_target_value,
        dynamics: {
          ...parameter.dynamics,
          max_speech_offset: 0,
        },
      };
    });
  if (release.length === 0) {
    return nextPlan;
  }
  return {
    ...nextPlan,
    parameters: [...nextPlan.parameters, ...release],
    diagnostics: {
      ...nextPlan.diagnostics,
      warnings: [
        ...(nextPlan.diagnostics?.warnings ?? []),
        `continuity_release_handoff:${release.length}`,
      ],
    },
  };
}

