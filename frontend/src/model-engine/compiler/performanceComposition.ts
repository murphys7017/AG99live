import type {
  SemanticAxisDefinition,
  SemanticAxisProfile,
} from "../../types/semantic-axis-profile.js";
import type {
  CompiledSemanticAxis,
  PerformanceCompositionAlignment,
  PerformanceCompositionDirection,
  PerformanceCompositionSignature,
} from "../../types/compiledSemanticMotion.js";
import {
  normalizeSemanticGroup,
  resolveStructuralSemanticGroup,
  SKELETON_COMPOSITION_GROUPS,
} from "./semanticGroupTaxonomy.js";

const ACTIVE_AXIS_THRESHOLD = 0.08;
const DIRECTION_EPSILON = 0.05;

export function buildPerformanceCompositionSignature(
  profile: SemanticAxisProfile,
  axes: readonly CompiledSemanticAxis[],
): PerformanceCompositionSignature {
  const axisById = new Map(profile.axes.map((axis) => [axis.id, axis]));
  const activeAxes = axes
    .map((axis) => {
      const definition = axisById.get(axis.axisId);
      if (!definition) {
        return null;
      }
      const normalizedDelta = normalizeAxisDelta(definition, axis.value);
      return {
        axis,
        definition,
        normalizedDelta,
        strength: Math.abs(normalizedDelta),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> =>
      entry !== null && entry.strength >= ACTIVE_AXIS_THRESHOLD);

  const axisDirections = Object.fromEntries(
    activeAxes
      .sort((left, right) => left.axis.axisId.localeCompare(right.axis.axisId))
      .map((entry) => [
        entry.axis.axisId,
        resolveDirection(entry.normalizedDelta),
      ]),
  );
  const groupStats = buildGroupStats(
    activeAxes,
    (entry) => normalizeSemanticGroup(entry.definition.semantic_group) || "unknown",
  );
  const structuralGroupStats = buildGroupStats(
    activeAxes,
    (entry) => resolveStructuralSemanticGroup(entry.definition.semantic_group),
  );
  const groupDirections = Object.fromEntries(
    [...groupStats.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([group, stats]) => [
        group,
        resolveGroupDirection(stats.positive, stats.negative),
      ]),
  );
  const normalizedDeltas = new Map(
    activeAxes.map((entry) => [entry.axis.axisId, entry.normalizedDelta]),
  );

  const primary = [...activeAxes].sort((left, right) =>
    right.strength - left.strength
    || left.axis.axisId.localeCompare(right.axis.axisId))[0];
  const skeletonDirections = SKELETON_COMPOSITION_GROUPS
    .map((group) => {
      const stats = structuralGroupStats.get(group);
      return stats
        ? resolveGroupDirection(stats.positive, stats.negative)
        : undefined;
    })
    .filter((direction): direction is PerformanceCompositionDirection =>
      direction === "negative" || direction === "positive" || direction === "mixed");
  const skeletonAlignment = resolveSkeletonAlignment(
    profile,
    normalizedDeltas,
    skeletonDirections,
  );
  const warnings = skeletonAlignment === "opposed"
    ? ["skeleton_relation_direction_conflict"]
    : [];

  return {
    version: "performance_composition.v1",
    primaryAxis: primary?.axis.axisId ?? null,
    primaryDirection: primary
      ? resolveDirection(primary.normalizedDelta)
      : "neutral",
    primaryStrength: roundCompositionNumber(primary?.strength ?? 0),
    activeAxisIds: activeAxes
      .map((entry) => entry.axis.axisId)
      .sort((left, right) => left.localeCompare(right)),
    activeGroups: [...groupStats.keys()].sort(),
    axisDirections,
    groupDirections: groupDirections as Record<string, PerformanceCompositionDirection>,
    skeletonAlignment,
    bodyInvolvement: roundCompositionNumber(
      structuralGroupStats.get("body")?.strength ?? 0,
    ),
    headInvolvement: roundCompositionNumber(
      structuralGroupStats.get("head")?.strength ?? 0,
    ),
    gazeInvolvement: roundCompositionNumber(
      structuralGroupStats.get("gaze")?.strength ?? 0,
    ),
    intensity: roundCompositionNumber(
      activeAxes.reduce((maximum, entry) => Math.max(maximum, entry.strength), 0),
    ),
    warnings,
  };
}

interface ActiveAxisEntry {
  axis: CompiledSemanticAxis;
  definition: SemanticAxisDefinition;
  normalizedDelta: number;
  strength: number;
}

interface GroupStats {
  positive: number;
  negative: number;
  strength: number;
}

function buildGroupStats(
  axes: readonly ActiveAxisEntry[],
  resolveGroup: (entry: ActiveAxisEntry) => string | null,
): Map<string, GroupStats> {
  const stats = new Map<string, GroupStats>();
  for (const entry of axes) {
    const group = resolveGroup(entry);
    if (!group) {
      continue;
    }
    const current = stats.get(group) ?? {
      positive: 0,
      negative: 0,
      strength: 0,
    };
    current.strength = Math.max(current.strength, entry.strength);
    if (entry.normalizedDelta >= 0) {
      current.positive += entry.strength;
    } else {
      current.negative += entry.strength;
    }
    stats.set(group, current);
  }
  return stats;
}

function resolveGroupDirection(
  positive: number,
  negative: number,
): PerformanceCompositionDirection {
  if (
    positive >= ACTIVE_AXIS_THRESHOLD
    && negative >= ACTIVE_AXIS_THRESHOLD
  ) {
    return "mixed";
  }
  if (positive - negative > DIRECTION_EPSILON) {
    return "positive";
  }
  if (negative - positive > DIRECTION_EPSILON) {
    return "negative";
  }
  return "neutral";
}

function resolveSkeletonAlignment(
  profile: SemanticAxisProfile,
  normalizedDeltas: ReadonlyMap<string, number>,
  directions: readonly PerformanceCompositionDirection[],
): PerformanceCompositionAlignment {
  let relatedPairCount = 0;
  let relationConflict = false;
  for (const rule of profile.relation_graph.edges) {
    const sourceDelta = normalizedDeltas.get(rule.source_axis_id);
    const targetDelta = normalizedDeltas.get(rule.target_axis_id);
    if (
      sourceDelta === undefined
      || targetDelta === undefined
      || Math.abs(sourceDelta) < ACTIVE_AXIS_THRESHOLD
      || Math.abs(targetDelta) < ACTIVE_AXIS_THRESHOLD
    ) {
      continue;
    }
    relatedPairCount += 1;
    const expectedDirection = rule.mode === "opposite_direction" ? -1 : 1;
    if (sourceDelta * targetDelta * expectedDirection < 0) {
      relationConflict = true;
    }
  }
  if (relatedPairCount > 0) {
    return relationConflict ? "opposed" : "aligned";
  }
  if (directions.length < 2) {
    return "missing";
  }
  if (directions.includes("mixed")) {
    return "partial";
  }
  const uniqueDirections = new Set(directions);
  if (uniqueDirections.size === 1) {
    return "aligned";
  }
  return "partial";
}

function normalizeAxisDelta(
  axis: SemanticAxisDefinition,
  value: number,
): number {
  const positiveSpan = Math.abs(axis.value_range[1] - axis.neutral);
  const negativeSpan = Math.abs(axis.neutral - axis.value_range[0]);
  const span = Math.max(positiveSpan, negativeSpan);
  if (span <= 0) {
    return 0;
  }
  return Math.max(-1, Math.min(1, (value - axis.neutral) / span));
}

function resolveDirection(value: number): PerformanceCompositionDirection {
  if (value > DIRECTION_EPSILON) {
    return "positive";
  }
  if (value < -DIRECTION_EPSILON) {
    return "negative";
  }
  return "neutral";
}

function roundCompositionNumber(value: number): number {
  return Math.round(value * 1000) / 1000;
}

