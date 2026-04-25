import type {
  BaseActionAtom,
  DirectParameterAxisCalibration,
  DirectParameterAxisName,
  DirectParameterPlanSupplementaryParam,
  ModelSummary,
  ParameterActionAtom,
} from "../types/protocol";
import {
  DEFAULT_AXIS_PARAMETER_EXCLUSIONS,
  DIRECT_PARAMETER_AXIS_NAMES,
  SUPPLEMENTARY_AXIS_THRESHOLD,
  SUPPLEMENTARY_MAX_COUNT,
} from "./constants";
import type { SupplementaryBuildResult } from "./contracts";

type AxisValues = Record<DirectParameterAxisName, number>;
type AxisPolarity = "positive" | "negative";
type LibraryKind = "parameter_action_library" | "base_action_library";

interface NormalizedSupplementaryAtom {
  id: string;
  parameterId: string;
  primaryChannel: string;
  polarity: string;
  semanticPolarity: string;
  score: number;
  energyScore: number;
  strength: string;
  kind: LibraryKind;
}

interface AxisSupplementaryConfig {
  preferredParameterIds: Set<string>;
  blockedParameterIds: Set<string>;
  candidateLimit: number;
  weightScale: number;
  targetScale: number;
}

interface CandidateSupplementaryParam extends DirectParameterPlanSupplementaryParam {
  score: number;
  energyScore: number;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function normalizeParameterId(value: unknown): string {
  return normalizeKey(value).replace(/[^a-z0-9]+/g, "");
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function axisProfile(
  model: ModelSummary,
  axisName: DirectParameterAxisName,
): DirectParameterAxisCalibration | null {
  const calibration = model.calibration_profile;
  return calibration?.axes?.[axisName]
    ?? calibration?.axis_calibrations?.[axisName]
    ?? null;
}

function parameterIdSetFromUnknown(value: unknown): Set<string> {
  const output = new Set<string>();
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    const normalized = normalizeParameterId(item);
    if (normalized) {
      output.add(normalized);
    }
  }
  return output;
}

function mergeParameterIdSets(...sets: Set<string>[]): Set<string> {
  const output = new Set<string>();
  for (const set of sets) {
    for (const item of set) {
      output.add(item);
    }
  }
  return output;
}

function collectAxisParameterExclusions(model: ModelSummary): Set<string> {
  const excluded = new Set<string>();

  for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
    for (const key of DEFAULT_AXIS_PARAMETER_EXCLUSIONS[axisName]) {
      excluded.add(normalizeParameterId(key));
    }

    const profile = axisProfile(model, axisName);
    if (!profile) {
      continue;
    }
    for (const item of parameterIdSetFromUnknown(profile.parameter_id)) {
      excluded.add(item);
    }
    for (const item of parameterIdSetFromUnknown(profile.parameter_ids)) {
      excluded.add(item);
    }
  }

  return excluded;
}

function resolveAxisConfig(
  model: ModelSummary,
  axisName: DirectParameterAxisName,
): AxisSupplementaryConfig {
  const profile = axisProfile(model, axisName);
  const candidateLimit = Math.max(
    1,
    Math.round(
      asFiniteNumber(profile?.supplementary_max_atoms)
      ?? asFiniteNumber(profile?.supplementary_top_k)
      ?? 2,
    ),
  );

  return {
    preferredParameterIds: mergeParameterIdSets(
      parameterIdSetFromUnknown(profile?.supplementary_preferred_parameter_ids),
      parameterIdSetFromUnknown(profile?.preferred_parameter_ids),
    ),
    blockedParameterIds: mergeParameterIdSets(
      parameterIdSetFromUnknown(profile?.supplementary_blocked_parameter_ids),
      parameterIdSetFromUnknown(profile?.supplementary_excluded_parameter_ids),
      parameterIdSetFromUnknown(profile?.blocked_parameter_ids),
    ),
    candidateLimit,
    weightScale: asFiniteNumber(profile?.supplementary_weight_scale) ?? 1,
    targetScale: asFiniteNumber(profile?.supplementary_target_scale) ?? 1,
  };
}

function strengthSemanticFactor(strength: string): number {
  switch (normalizeKey(strength)) {
    case "none":
      return 0.35;
    case "low":
      return 0.55;
    case "medium":
      return 0.78;
    case "high":
      return 1;
    default:
      return 0.65;
  }
}

function normalizeParameterActionAtom(
  atom: ParameterActionAtom,
): NormalizedSupplementaryAtom | null {
  const parameterId = normalizeText(atom.parameter_id);
  const primaryChannel = normalizeText(atom.primary_channel);
  if (!parameterId || !primaryChannel) {
    return null;
  }

  return {
    id: normalizeText(atom.id),
    parameterId,
    primaryChannel,
    polarity: normalizeText(atom.polarity) || "neutral",
    semanticPolarity: normalizeText(atom.semantic_polarity),
    score: Number(atom.score || 0),
    energyScore: Number(atom.energy_score || 0),
    strength: normalizeText(atom.strength) || "none",
    kind: "parameter_action_library",
  };
}

function normalizeBaseActionAtom(
  atom: BaseActionAtom,
): NormalizedSupplementaryAtom | null {
  const parameterId = normalizeText(atom.parameter_id);
  const primaryChannel = normalizeText(atom.channel);
  if (!parameterId || !primaryChannel) {
    return null;
  }

  return {
    id: normalizeText(atom.id),
    parameterId,
    primaryChannel,
    polarity: normalizeText(atom.polarity) || "neutral",
    semanticPolarity: normalizeText(atom.semantic_polarity),
    score: Number(atom.score || 0),
    energyScore: Number(atom.energy_score || 0),
    strength: normalizeText(atom.strength) || "none",
    kind: "base_action_library",
  };
}

function polarityMatches(
  atom: NormalizedSupplementaryAtom,
  polarity: AxisPolarity,
  allowRelaxedMatching: boolean,
): boolean {
  if (normalizeKey(atom.polarity) === polarity) {
    return true;
  }
  if (normalizeKey(atom.semanticPolarity) === polarity) {
    return true;
  }
  return allowRelaxedMatching;
}

function buildCandidatesForLibrary(
  atoms: NormalizedSupplementaryAtom[],
  axisValues: AxisValues,
  model: ModelSummary,
  options: { allowRelaxedMatching: boolean },
): DirectParameterPlanSupplementaryParam[] {
  const excludedParameterIds = collectAxisParameterExclusions(model);
  const selectedByParameter = new Map<string, CandidateSupplementaryParam>();

  for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
    const axisValue = Number(axisValues[axisName] ?? 50);
    const delta = axisValue - 50;
    if (Math.abs(delta) < SUPPLEMENTARY_AXIS_THRESHOLD) {
      continue;
    }

    const axisConfig = resolveAxisConfig(model, axisName);
    const polarity: AxisPolarity = delta > 0 ? "positive" : "negative";
    const direction = delta > 0 ? 1 : -1;
    const normalizedStrength = clampNumber(Math.abs(delta) / 50, 0, 1);
    const weight = round4(
      clampNumber(
        (0.15 + normalizedStrength * 0.75) * axisConfig.weightScale,
        0,
        1,
      ),
    );

    const rankedAtoms = atoms
      .filter((atom) => normalizeKey(atom.primaryChannel) === normalizeKey(axisName))
      .filter((atom) => polarityMatches(atom, polarity, options.allowRelaxedMatching))
      .filter((atom) => {
        const parameterKey = normalizeParameterId(atom.parameterId);
        return parameterKey && !axisConfig.blockedParameterIds.has(parameterKey);
      })
      .sort((left, right) => {
        const leftPolarityPenalty = normalizeKey(left.polarity) === polarity ? 0 : 1;
        const rightPolarityPenalty = normalizeKey(right.polarity) === polarity ? 0 : 1;
        if (leftPolarityPenalty !== rightPolarityPenalty) {
          return leftPolarityPenalty - rightPolarityPenalty;
        }

        const leftPreferredPenalty = axisConfig.preferredParameterIds.has(
          normalizeParameterId(left.parameterId),
        ) ? 0 : 1;
        const rightPreferredPenalty = axisConfig.preferredParameterIds.has(
          normalizeParameterId(right.parameterId),
        ) ? 0 : 1;
        if (leftPreferredPenalty !== rightPreferredPenalty) {
          return leftPreferredPenalty - rightPreferredPenalty;
        }

        if (left.score !== right.score) {
          return right.score - left.score;
        }
        if (left.energyScore !== right.energyScore) {
          return right.energyScore - left.energyScore;
        }
        return left.id.localeCompare(right.id);
      })
      .slice(0, axisConfig.candidateLimit);

    for (const atom of rankedAtoms) {
      const parameterKey = normalizeParameterId(atom.parameterId);
      if (!parameterKey || excludedParameterIds.has(parameterKey)) {
        continue;
      }

      const targetValue = round4(
        clampNumber(
          direction
          * normalizedStrength
          * strengthSemanticFactor(atom.strength)
          * axisConfig.targetScale,
          -1,
          1,
        ),
      );
      const candidate: CandidateSupplementaryParam = {
        parameter_id: atom.parameterId,
        target_value: targetValue,
        weight,
        source_atom_id: atom.id || `${axisName}.${parameterKey}`,
        channel: axisName,
        score: atom.score,
        energyScore: atom.energyScore,
      };

      const existing = selectedByParameter.get(parameterKey);
      if (
        !existing
        || candidate.score > existing.score
        || (
          candidate.score === existing.score
          && candidate.energyScore > existing.energyScore
        )
      ) {
        selectedByParameter.set(parameterKey, candidate);
      }
    }
  }

  return [...selectedByParameter.values()]
    .sort((left, right) => {
      if (left.weight !== right.weight) {
        return right.weight - left.weight;
      }
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.parameter_id.localeCompare(right.parameter_id);
    })
    .slice(0, SUPPLEMENTARY_MAX_COUNT)
    .map((item) => ({
      parameter_id: item.parameter_id,
      target_value: item.target_value,
      weight: item.weight,
      source_atom_id: item.source_atom_id,
      channel: item.channel,
    }));
}

export function buildSupplementaryParams(
  axisValues: AxisValues,
  model: ModelSummary,
): SupplementaryBuildResult {
  const parameterAtoms = (model.parameter_action_library?.atoms ?? [])
    .map(normalizeParameterActionAtom)
    .filter((atom): atom is NormalizedSupplementaryAtom => atom !== null);

  const parameterCandidates = buildCandidatesForLibrary(
    parameterAtoms,
    axisValues,
    model,
    { allowRelaxedMatching: false },
  );
  if (parameterCandidates.length > 0) {
    return {
      params: parameterCandidates,
      diagnostics: {
        usedFallbackLibrary: false,
        selectedFrom: "parameter_action_library",
      },
    };
  }

  const baseAtoms = (model.base_action_library?.atoms ?? [])
    .map(normalizeBaseActionAtom)
    .filter((atom): atom is NormalizedSupplementaryAtom => atom !== null);
  const baseCandidates = buildCandidatesForLibrary(
    baseAtoms,
    axisValues,
    model,
    { allowRelaxedMatching: true },
  );

  return {
    params: baseCandidates,
    diagnostics: {
      usedFallbackLibrary: baseCandidates.length > 0,
      selectedFrom: baseCandidates.length > 0 ? "base_action_library" : "none",
    },
  };
}
