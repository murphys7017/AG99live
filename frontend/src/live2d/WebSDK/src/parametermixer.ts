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
  clamped: boolean;
}

export interface ResolvedParameterFrameEntry {
  parameterId: CubismIdHandle;
  parameterIdRaw: string;
  parameterIndex: number;
  baseValue: number;
  value: number;
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
        return { ok: false, reason: invalidReason };
      }
      const existing = grouped.get(contribution.parameterIndex);
      if (existing) {
        if (existing.parameterIdRaw !== contribution.parameterIdRaw) {
          return {
            ok: false,
            reason: `parameter_mixer_parameter_identity_conflict:${existing.parameterIdRaw}:${contribution.parameterIdRaw}`,
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
        };
      }
      if (!Number.isFinite(baseValue)) {
        return {
          ok: false,
          reason: `parameter_mixer_invalid_base_value:${group.parameterIdRaw}`,
        };
      }

      let value = clamp(baseValue, minValue, maxValue);
      const resolvedContributions: ResolvedParameterContribution[] = [];
      group.contributions
        .sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)
        .forEach((contribution) => {
          const rawValue = resolveContributionValue(value, contribution);
          const resolvedValue = clamp(rawValue, minValue, maxValue);
          resolvedContributions.push({
            source: contribution.source,
            operation: contribution.operation,
            value: contribution.value,
            weight: contribution.weight,
            priority: contribution.priority,
            resolvedValue,
            clamped: resolvedValue !== rawValue,
          });
          value = resolvedValue;
        });

      parameters.push({
        parameterId: group.parameterId,
        parameterIdRaw: group.parameterIdRaw,
        parameterIndex,
        baseValue,
        value,
        contributions: resolvedContributions,
      });
    }

    return { ok: true, parameters };
  }

}

function validateContribution(
  contribution: ParameterContribution,
  access: ParameterMixerAccess,
): string | null {
  if (!contribution.parameterIdRaw || !access.isParameterIndexWritable(contribution.parameterIndex)) {
    return `parameter_mixer_parameter_not_writable:${contribution.parameterIdRaw || contribution.parameterIndex}`;
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
