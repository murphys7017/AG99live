import type { CompileOptions } from "./contracts.js";
import { SCHEMA_MOTION_INTENT_V4 } from "../../types/protocol.js";
import {
  SEMANTIC_MOTION_TRANSFORM_VERSION,
  type CompileDiagnostics,
  type MotionTransformTrace,
} from "../../types/compiledSemanticMotion.js";
import type { MotionCompileContext } from "./compileContext.js";
import type { ModelEngineSettings } from "../settings.js";
import { buildPerformanceCompositionSignature } from "./performanceComposition.js";
import {
  normalizeSemanticGroup,
  resolveStructuralSemanticGroup,
  SKELETON_COMPOSITION_GROUPS,
} from "./semanticGroupTaxonomy.js";

export function buildBaseCompileDiagnostics(
  options: CompileOptions,
  settings: ModelEngineSettings,
): CompileDiagnostics {
  return {
    usedActionLibrary: false,
    compiledParameterCount: 0,
    timingSource: "default",
    resolvedMode: "idle",
    speechActive: options.speechActive === true,
    source: options.source,
    intensityApplied: false,
    motionIntensityScale: settings.motionIntensityScale,
    warnings: [],
  };
}

export function finalizeCompileDiagnostics(
  context: MotionCompileContext,
  extra: Partial<CompileDiagnostics> = {},
): CompileDiagnostics {
  const { baseDiagnostics, state } = context;
  const appliedDerivedAxes = [...state.appliedDerivedAxes];
  const visibility = buildVisibilityDiagnostics(context);

  return {
    ...baseDiagnostics,
    timingSource: state.timing?.timingSource ?? baseDiagnostics.timingSource,
    resolvedMode: state.resolvedMode,
    compiledParameterCount: 0,
    warnings: [...state.warnings],
    primaryAxes: [...state.roleAxisIds.primaryAxes],
    hintAxes: [...state.roleAxisIds.hintAxes],
    derivedAxes: appliedDerivedAxes,
    availableDerivedAxes: [...state.roleAxisIds.derivedAxes],
    appliedDerivedAxes,
    runtimeAxes: [...state.roleAxisIds.runtimeAxes],
    forbiddenAxes: [...state.forbiddenAxes],
    invalidAxes: [...state.invalidAxes],
    compiledParameters: [],
    ...visibility,
    ...extra,
  };
}

function buildVisibilityDiagnostics(
  context: MotionCompileContext,
): Partial<CompileDiagnostics> {
  const activeGroups = new Set<string>();
  const activeStructuralGroups = new Set<string>();
  let maxDeltaFromNeutral = 0;
  let neutralishAxisCount = 0;
  let expressiveAxisCount = 0;

  for (const [axisId, value] of Object.entries(context.state.allAxisValues)) {
    const axis = context.state.axisById.get(axisId);
    if (!axis) {
      continue;
    }
    const group = normalizeSemanticGroup(axis.semantic_group);
    if (group) {
      activeGroups.add(group);
    }
    const structuralGroup = resolveStructuralSemanticGroup(axis.semantic_group);
    if (structuralGroup) {
      activeStructuralGroups.add(structuralGroup);
    }
    const delta = Math.abs(value - axis.neutral);
    maxDeltaFromNeutral = Math.max(maxDeltaFromNeutral, delta);
    if (isAxisWithinSoftRange(value, axis.soft_range)) {
      neutralishAxisCount += 1;
    } else {
      expressiveAxisCount += 1;
    }
  }

  const activeGroupList = [...activeGroups].sort();
  const skeletonGroups = SKELETON_COMPOSITION_GROUPS.filter((group) =>
    activeStructuralGroups.has(group));
  const missingSkeletonGroups = SKELETON_COMPOSITION_GROUPS.filter((group) =>
    !activeStructuralGroups.has(group));

  return {
    activeGroups: activeGroupList,
    skeletonGroups,
    missingSkeletonGroups,
    maxDeltaFromNeutral: roundDiagnosticNumber(maxDeltaFromNeutral),
    neutralishAxisCount,
    expressiveAxisCount,
    semanticAxisCount: Object.keys(context.state.allAxisValues).length,
    relationSkippedExplicitTargets: collectRelationSkippedExplicitTargets(context.state.warnings),
    relationAdjustments: [...context.state.relationAdjustments],
    relationEvaluations: context.state.relationEvaluations.map((item) => ({ ...item })),
    performanceComposition: context.state.profile
      ? buildPerformanceCompositionSignature(
          context.state.profile,
          Object.entries(context.state.allAxisValues)
            .map(([axisId, value]) => ({
              axisId,
              value,
              neutralValue: context.state.axisById.get(axisId)?.neutral ?? 0,
              source: context.state.axisValueSources[axisId] === "relation_graph"
                ? "relation_graph"
                : "semantic_axis",
            })),
        )
      : undefined,
    transformTrace: buildTransformTrace(context),
  };
}

function buildTransformTrace(context: MotionCompileContext): MotionTransformTrace {
  const profile = context.state.profile;
  return {
    transformVersion: SEMANTIC_MOTION_TRANSFORM_VERSION,
    profileRevision: profile?.revision ?? 0,
    profileHash: profile?.source_hash ?? "",
    rawAxes: {},
    rawAxisLevels: context.intent.axis_levels
      ? { ...context.intent.axis_levels }
      : undefined,
    axisSampling: context.state.axisSampling
      ? {
          ...context.state.axisSampling,
          groupRandom: { ...context.state.axisSampling.groupRandom },
          perAxisRandom: { ...context.state.axisSampling.perAxisRandom },
          sampledValues: { ...context.state.axisSampling.sampledValues },
          sampleBounds: Object.fromEntries(
            Object.entries(context.state.axisSampling.sampleBounds).map(
              ([axisId, bounds]) => [axisId, { ...bounds }],
            ),
          ),
        }
      : undefined,
    expressionResourceId: context.intent.schema_version === SCHEMA_MOTION_INTENT_V4
      ? context.intent.expression_resource_id
      : undefined,
    motionResourceId: context.intent.schema_version === SCHEMA_MOTION_INTENT_V4
      ? context.intent.motion_resource_id
      : undefined,
    resolvedResource: undefined,
    resolvedAxes: { ...context.state.controlledValues },
    derivedAxes: { ...context.state.derivedValues },
    constrainedAxes: { ...context.state.allAxisValues },
    relationAdjustments: [...context.state.relationAdjustments],
    relationEvaluations: context.state.relationEvaluations.map((item) => ({ ...item })),
    compiledParameters: [],
  };
}

function isAxisWithinSoftRange(value: number, softRange: readonly [number, number]): boolean {
  return value >= softRange[0] && value <= softRange[1];
}

function collectRelationSkippedExplicitTargets(warnings: readonly string[]): string[] {
  const targets: string[] = [];
  for (const warning of warnings) {
    const match = /^semantic_relation_skipped_explicit_target:[^:]+:([^:]+)$/.exec(warning);
    if (match?.[1]) {
      targets.push(match[1]);
    }
  }
  return [...new Set(targets)];
}

function roundDiagnosticNumber(value: number): number {
  return Math.round(value * 10000) / 10000;
}
