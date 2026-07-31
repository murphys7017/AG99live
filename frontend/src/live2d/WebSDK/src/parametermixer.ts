import type { CubismIdHandle } from "@framework/id/cubismid";

export const PARAMETER_MIX_PRIORITY = {
  directPlan: 100,
  lipSync: 200,
} as const;

export type ParameterContributionOperation = "replace" | "add" | "multiply";

export interface ParameterContribution {
  parameterId: CubismIdHandle;
  parameterIdRaw: string;
  parameterIndex: number;
  source: string;
  operation: ParameterContributionOperation;
  value: number;
  weight: number;
  priority: number;
}

export interface ParameterMixerAccess {
  isParameterIndexWritable: (parameterIndex: number) => boolean;
  getParameterValue: (parameterIndex: number) => number;
  getParameterMinimumValue: (parameterIndex: number) => number;
  getParameterMaximumValue: (parameterIndex: number) => number;
}

export interface ResolvedParameterContribution {
  source: string;
  operation: ParameterContributionOperation;
  value: number;
  weight: number;
  priority: number;
  resolvedValue: number;
}

export interface ResolvedParameterFrameEntry {
  parameterId: CubismIdHandle;
  parameterIdRaw: string;
  parameterIndex: number;
  baseValue: number;
  unclampedValue: number;
  value: number;
  clamped: boolean;
  contributions: ResolvedParameterContribution[];
}

export type ParameterMixerResolution =
  | {
      ok: true;
      parameters: ResolvedParameterFrameEntry[];
    }
  | {
      ok: false;
      reason: string;
      sources: string[];
    };

/**
 * Resolves already-produced active parameter contributions. It never interprets
 * semantic levels, owns source lifecycle, or writes Cubism parameters.
 */
export class ParameterMixer {
  public resolveFrame(
    contributions: readonly ParameterContribution[],
    access: ParameterMixerAccess,
  ): ParameterMixerResolution {
    const grouped = new Map<number, {
      parameterId: CubismIdHandle;
      parameterIdRaw: string;
      contributions: Array<ParameterContribution & { sequence: number }>;
    }>();

    for (const [sequence, contribution] of contributions.entries()) {
      const invalidReason = validateContribution(contribution, access);
      if (invalidReason) {
        return {
          ok: false,
          reason: invalidReason,
          sources: contribution.source ? [contribution.source] : [],
        };
      }
      const existing = grouped.get(contribution.parameterIndex);
      if (existing) {
        if (existing.parameterIdRaw !== contribution.parameterIdRaw) {
          return {
            ok: false,
            reason: `parameter_mixer_parameter_identity_conflict:${existing.parameterIdRaw}:${contribution.parameterIdRaw}`,
            sources: collectContributionSources([
              ...existing.contributions,
              contribution,
            ]),
          };
        }
        existing.contributions.push({ ...contribution, sequence });
        continue;
      }
      grouped.set(contribution.parameterIndex, {
        parameterId: contribution.parameterId,
        parameterIdRaw: contribution.parameterIdRaw,
        contributions: [{ ...contribution, sequence }],
      });
    }

    const parameters: ResolvedParameterFrameEntry[] = [];
    for (const [parameterIndex, group] of grouped) {
      const minValue = access.getParameterMinimumValue(parameterIndex);
      const maxValue = access.getParameterMaximumValue(parameterIndex);
      const baseValue = access.getParameterValue(parameterIndex);
      if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue > maxValue) {
        return {
          ok: false,
          reason: `parameter_mixer_invalid_runtime_range:${group.parameterIdRaw}`,
          sources: collectContributionSources(group.contributions),
        };
      }
      if (!Number.isFinite(baseValue)) {
        return {
          ok: false,
          reason: `parameter_mixer_invalid_base_value:${group.parameterIdRaw}`,
          sources: collectContributionSources(group.contributions),
        };
      }

      let unclampedValue = baseValue;
      const resolvedContributions: ResolvedParameterContribution[] = [];
      group.contributions
        .sort((left, right) => {
          const priorityOrder = left.priority - right.priority;
          if (priorityOrder !== 0) {
            return priorityOrder;
          }
          const sourceOrder = left.source.localeCompare(right.source);
          return sourceOrder !== 0 ? sourceOrder : left.sequence - right.sequence;
        })
        .forEach((contribution) => {
          const resolvedValue = resolveContributionValue(unclampedValue, contribution);
          resolvedContributions.push({
            source: contribution.source,
            operation: contribution.operation,
            value: contribution.value,
            weight: contribution.weight,
            priority: contribution.priority,
            resolvedValue,
          });
          unclampedValue = resolvedValue;
        });
      const value = clamp(unclampedValue, minValue, maxValue);

      parameters.push({
        parameterId: group.parameterId,
        parameterIdRaw: group.parameterIdRaw,
        parameterIndex,
        baseValue,
        unclampedValue,
        value,
        clamped: value !== unclampedValue,
        contributions: resolvedContributions,
      });
    }

    return { ok: true, parameters };
  }

}

function collectContributionSources(
  contributions: readonly Pick<ParameterContribution, "source">[],
): string[] {
  return [...new Set(
    contributions
      .map((contribution) => contribution.source)
      .filter((source): source is string => typeof source === "string" && Boolean(source.trim())),
  )];
}

function validateContribution(
  contribution: ParameterContribution,
  access: ParameterMixerAccess,
): string | null {
  if (typeof contribution.parameterIdRaw !== "string" || !contribution.parameterIdRaw.trim()) {
    return `parameter_mixer_parameter_id_missing:${contribution.parameterIndex}`;
  }
  if (contribution.parameterId == null) {
    return `parameter_mixer_parameter_handle_missing:${contribution.parameterIdRaw}`;
  }
  if (!Number.isInteger(contribution.parameterIndex)) {
    return `parameter_mixer_invalid_parameter_index:${contribution.parameterIdRaw}`;
  }
  if (!access.isParameterIndexWritable(contribution.parameterIndex)) {
    return `parameter_mixer_parameter_not_writable:${contribution.parameterIdRaw}`;
  }
  if (typeof contribution.source !== "string" || !contribution.source.trim()) {
    return `parameter_mixer_source_missing:${contribution.parameterIdRaw}`;
  }
  if (!isParameterContributionOperation(contribution.operation)) {
    return `parameter_mixer_invalid_operation:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  if (!Number.isFinite(contribution.value) || !Number.isFinite(contribution.weight)) {
    return `parameter_mixer_non_finite_contribution:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  if (!Number.isFinite(contribution.priority)) {
    return `parameter_mixer_invalid_priority:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  if (contribution.operation === "replace" && (contribution.weight < 0 || contribution.weight > 1)) {
    return `parameter_mixer_invalid_replace_weight:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  if (contribution.operation !== "replace" && contribution.weight < 0) {
    return `parameter_mixer_invalid_weight:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  return null;
}

function isParameterContributionOperation(
  operation: unknown,
): operation is ParameterContributionOperation {
  return operation === "replace" || operation === "add" || operation === "multiply";
}

function resolveContributionValue(
  currentValue: number,
  contribution: ParameterContribution,
): number {
  if (contribution.operation === "replace") {
    return currentValue * (1 - contribution.weight) + contribution.value * contribution.weight;
  }
  if (contribution.operation === "add") {
    return currentValue + contribution.value * contribution.weight;
  }
  return currentValue * (1 + (contribution.value - 1) * contribution.weight);
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}
