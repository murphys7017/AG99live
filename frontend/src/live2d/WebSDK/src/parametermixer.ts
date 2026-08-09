import type { CubismIdHandle } from "@framework/id/cubismid";

export const PARAMETER_MIX_PRIORITY = {
  directPlan: 100,
  lipSync: 200,
} as const;

export type ParameterContributionOwner = "direct_plan" | "lip_sync";
export type ParameterFrameOwner = ParameterContributionOwner | "mixed";

export interface ParameterContribution {
  parameterIdRaw: string;
  parameterIndex: number;
  owner: ParameterContributionOwner;
  source: string;
  value: number;
  weight: number;
  priority: number;
}

export type ParameterBaseSnapshot =
  | {
      parameterId: CubismIdHandle;
      parameterIdRaw: string;
      writable: true;
      baseValue: number;
      minimumValue: number;
      maximumValue: number;
    }
  | {
      writable: false;
    };

export interface ResolvedParameterContribution {
  owner: ParameterContributionOwner;
  source: string;
  value: number;
  weight: number;
  priority: number;
  resolvedValue: number;
}

export interface ResolvedParameterFrameEntry {
  parameterId: CubismIdHandle;
  parameterIdRaw: string;
  parameterIndex: number;
  owner: ParameterFrameOwner;
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
      owner: ParameterFrameOwner;
    };

/**
 * Resolves one frozen Cubism base snapshot with already-produced active
 * parameter contributions. It never reads or writes Cubism state, interprets
 * semantic levels, or owns source lifecycle.
 */
export class ParameterMixer {
  public resolveFrame(
    contributions: readonly ParameterContribution[],
    baseSnapshots: ReadonlyMap<number, ParameterBaseSnapshot>,
  ): ParameterMixerResolution {
    const grouped = new Map<number, {
      parameterIdRaw: string;
      contributions: Array<ParameterContribution & { sequence: number }>;
    }>();

    for (const [sequence, contribution] of contributions.entries()) {
      const invalidReason = validateContribution(contribution);
      if (invalidReason) {
        return {
          ok: false,
          reason: invalidReason,
          owner: isParameterContributionOwner(contribution.owner)
            ? contribution.owner
            : "mixed",
        };
      }
      const existing = grouped.get(contribution.parameterIndex);
      if (existing) {
        if (existing.parameterIdRaw !== contribution.parameterIdRaw) {
          return {
            ok: false,
            reason: `parameter_mixer_parameter_identity_conflict:${existing.parameterIdRaw}:${contribution.parameterIdRaw}`,
            owner: resolveContributionOwner([
              ...existing.contributions,
              contribution,
            ]),
          };
        }
        existing.contributions.push({ ...contribution, sequence });
        continue;
      }
      grouped.set(contribution.parameterIndex, {
        parameterIdRaw: contribution.parameterIdRaw,
        contributions: [{ ...contribution, sequence }],
      });
    }

    const parameters: ResolvedParameterFrameEntry[] = [];
    const orderedGroups = [...grouped.entries()]
      .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex);
    for (const [parameterIndex, group] of orderedGroups) {
      const owner = resolveContributionOwner(group.contributions);
      const snapshot = baseSnapshots.get(parameterIndex);
      if (!snapshot) {
        return {
          ok: false,
          reason: `parameter_mixer_base_snapshot_missing:${group.parameterIdRaw}`,
          owner,
        };
      }
      if (!snapshot.writable) {
        return {
          ok: false,
          reason: `parameter_mixer_parameter_not_writable:${group.parameterIdRaw}`,
          owner,
        };
      }
      if (snapshot.parameterIdRaw !== group.parameterIdRaw) {
        return {
          ok: false,
          reason: `parameter_mixer_base_snapshot_identity_conflict:${snapshot.parameterIdRaw}:${group.parameterIdRaw}`,
          owner,
        };
      }
      const minValue = snapshot.minimumValue;
      const maxValue = snapshot.maximumValue;
      const baseValue = snapshot.baseValue;
      if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue > maxValue) {
        return {
          ok: false,
          reason: `parameter_mixer_invalid_runtime_range:${group.parameterIdRaw}`,
          owner,
        };
      }
      if (!Number.isFinite(baseValue)) {
        return {
          ok: false,
          reason: `parameter_mixer_invalid_base_value:${group.parameterIdRaw}`,
          owner,
        };
      }

      let unclampedValue = baseValue;
      const resolvedContributions: ResolvedParameterContribution[] = [];
      const orderedContributions = group.contributions.sort((left, right) => {
        const priorityOrder = left.priority - right.priority;
        if (priorityOrder !== 0) {
          return priorityOrder;
        }
        const sourceOrder = left.source.localeCompare(right.source);
        return sourceOrder !== 0 ? sourceOrder : left.sequence - right.sequence;
      });
      for (const contribution of orderedContributions) {
        const resolvedValue = resolveContributionValue(unclampedValue, contribution);
        resolvedContributions.push({
          owner: contribution.owner,
          source: contribution.source,
          value: contribution.value,
          weight: contribution.weight,
          priority: contribution.priority,
          resolvedValue,
        });
        unclampedValue = resolvedValue;
      }
      const value = clamp(unclampedValue, minValue, maxValue);

      parameters.push({
        parameterId: snapshot.parameterId,
        parameterIdRaw: group.parameterIdRaw,
        parameterIndex,
        owner,
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

function resolveContributionOwner(
  contributions: readonly Pick<ParameterContribution, "owner">[],
): ParameterFrameOwner {
  let owner: ParameterContributionOwner | null = null;
  for (const contribution of contributions) {
    if (!isParameterContributionOwner(contribution.owner)) {
      continue;
    }
    if (owner !== null && owner !== contribution.owner) {
      return "mixed";
    }
    owner = contribution.owner;
  }
  return owner ?? "mixed";
}

function validateContribution(
  contribution: ParameterContribution,
): string | null {
  if (typeof contribution.parameterIdRaw !== "string" || !contribution.parameterIdRaw.trim()) {
    return `parameter_mixer_parameter_id_missing:${contribution.parameterIndex}`;
  }
  if (!Number.isInteger(contribution.parameterIndex) || contribution.parameterIndex < 0) {
    return `parameter_mixer_invalid_parameter_index:${contribution.parameterIdRaw}`;
  }
  if (!isParameterContributionOwner(contribution.owner)) {
    return `parameter_mixer_owner_invalid:${contribution.parameterIdRaw}`;
  }
  if (typeof contribution.source !== "string" || !contribution.source.trim()) {
    return `parameter_mixer_source_missing:${contribution.parameterIdRaw}`;
  }
  if (!Number.isFinite(contribution.value) || !Number.isFinite(contribution.weight)) {
    return `parameter_mixer_non_finite_contribution:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  if (!Number.isFinite(contribution.priority)) {
    return `parameter_mixer_invalid_priority:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  if (contribution.weight < 0 || contribution.weight > 1) {
    return `parameter_mixer_invalid_weight:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  return null;
}

function isParameterContributionOwner(
  owner: unknown,
): owner is ParameterContributionOwner {
  return owner === "direct_plan" || owner === "lip_sync";
}

function resolveContributionValue(
  currentValue: number,
  contribution: ParameterContribution,
): number {
  return currentValue * (1 - contribution.weight)
    + contribution.value * contribution.weight;
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}
