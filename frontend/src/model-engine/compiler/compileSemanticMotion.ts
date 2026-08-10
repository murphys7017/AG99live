import type {
  NormalizedSemanticMotionIntentV4,
  SemanticMotionIntent,
} from "../../types/protocol.js";
import { SCHEMA_MOTION_INTENT_V4 } from "../../types/protocol.js";
import { normalizeModelEngineSettings } from "../settings.js";
import {
  createInitialCompileState,
  type MotionCompileContext,
} from "./compileContext.js";
import type {
  CompileDiagnostics,
  CompiledSemanticAxis,
  CompiledSemanticMotion,
} from "../../types/compiledSemanticMotion.js";
import type {
  CompileOptions,
  CompileSemanticMotionResult,
} from "./contracts.js";
import {
  buildBaseCompileDiagnostics,
  finalizeCompileDiagnostics,
} from "./diagnostics.js";
import { runCompilePipeline } from "./pipeline.js";
import {
  createModelEngineStageRegistry,
  type ModelEngineStageRegistry,
} from "./registry.js";

type CompileSemanticPoseContextResult =
  | {
    ok: true;
    context: MotionCompileContext;
    axes: CompiledSemanticAxis[];
    diagnostics: CompileDiagnostics;
  }
  | Extract<CompileSemanticMotionResult, { ok: false }>;

export function compileSemanticMotion(
  intent: SemanticMotionIntent,
  options: CompileOptions,
  stageRegistry: ModelEngineStageRegistry = createModelEngineStageRegistry(),
): CompileSemanticMotionResult {
  if (
    intent.schema_version === SCHEMA_MOTION_INTENT_V4
    && Array.isArray(intent.motion_steps)
  ) {
    return compileSemanticSequence(
      intent as NormalizedSemanticMotionIntentV4 & {
        motion_steps: NonNullable<NormalizedSemanticMotionIntentV4["motion_steps"]>;
      },
      options,
      stageRegistry,
    );
  }
  const compiled = compileSemanticPoseContext(intent, options, stageRegistry);
  if (!compiled.ok) {
    return compiled;
  }
  return {
    ok: true,
    reason: "",
    motion: buildMotionBase(compiled.context, compiled.diagnostics, {
      kind: "pose",
      axes: compiled.axes,
    }),
  };
}

function compileSemanticSequence(
  intent: NormalizedSemanticMotionIntentV4 & {
    motion_steps: NonNullable<NormalizedSemanticMotionIntentV4["motion_steps"]>;
  },
  options: CompileOptions,
  stageRegistry: ModelEngineStageRegistry,
): CompileSemanticMotionResult {
  const compiledSteps = intent.motion_steps.map((step) =>
    compileSemanticPoseContext(
      {
        ...intent,
        axis_levels: step.axis_levels,
        motion_steps: undefined,
      } as NormalizedSemanticMotionIntentV4,
      { ...options, allowNeutralAxisPose: true },
      stageRegistry,
    ),
  );
  const failedStepIndex = compiledSteps.findIndex((step) => !step.ok);
  if (failedStepIndex >= 0) {
    const failed = compiledSteps[failedStepIndex];
    if (failed.ok) {
      throw new Error("semantic_sequence_failure_resolution_invalid");
    }
    return {
      ...failed,
      reason: `semantic_sequence_step_failed:${failedStepIndex}:${failed.reason}`,
      feedback: {
        ...failed.feedback,
        code: `semantic_sequence_step_failed:${failedStepIndex}`,
      },
    };
  }

  const successfulSteps = compiledSteps.filter(
    (step): step is Extract<typeof step, { ok: true }> => step.ok,
  );
  const signatures = successfulSteps.map((step) =>
    JSON.stringify(step.axes.map((axis) => [axis.axisId, axis.value])),
  );
  if (signatures.every((signature) => signature === signatures[0])) {
    return failSemanticCompile(
      "semantic_sequence_has_no_transition",
      successfulSteps[0].context,
    );
  }

  const first = successfulSteps[0];
  const warnings = Array.from(new Set(
    successfulSteps.flatMap((step) => step.diagnostics.warnings ?? []),
  ));
  const diagnostics: CompileDiagnostics = {
    ...first.diagnostics,
    warnings: [...warnings, `semantic_sequence_compiled:${successfulSteps.length}`],
  };
  return {
    ok: true,
    reason: "",
    motion: buildMotionBase(first.context, diagnostics, {
      kind: "sequence",
      steps: successfulSteps.map((step, index) => ({
        durationWeight: intent.motion_steps[index].duration_weight,
        axes: step.axes,
        diagnostics: step.diagnostics,
      })),
    }),
  };
}

function compileSemanticPoseContext(
  intent: SemanticMotionIntent,
  options: CompileOptions,
  stageRegistry: ModelEngineStageRegistry,
): CompileSemanticPoseContextResult {
  const settings = normalizeModelEngineSettings(options.settings);
  const context: MotionCompileContext = {
    intent,
    options,
    settings,
    baseDiagnostics: buildBaseCompileDiagnostics(options, settings),
    state: createInitialCompileState(),
  };
  context.state.warnings.push(...(options.runtimeWarnings ?? []));

  const stages = stageRegistry.resolve(context, "semantic");
  const pipelineResult = runCompilePipeline(context, stages);
  if (!pipelineResult.ok) {
    return failSemanticCompile(pipelineResult.reason, context, pipelineResult.stageId);
  }
  const profile = context.state.profile;
  if (!profile || !context.state.timing) {
    return failSemanticCompile("semantic_compile_missing_required_state", context);
  }

  const axes = Object.entries(context.state.allAxisValues)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([axisId, value]): CompiledSemanticAxis => {
      const axis = context.state.axisById.get(axisId);
      const source = context.state.axisValueSources[axisId];
      if (!axis || !source) {
        throw new Error(`semantic_compile_axis_state_missing:${axisId}`);
      }
      if (source !== "semantic_axis" && source !== "relation_graph") {
        throw new Error(`semantic_compile_axis_source_invalid:${axisId}:${source}`);
      }
      return {
        axisId,
        value,
        neutralValue: axis.neutral,
        source,
      };
    });
  if (axes.length === 0 && options.speechActive !== true) {
    return failSemanticCompile("semantic_compile_axes_empty", context);
  }
  return {
    ok: true,
    context,
    axes,
    diagnostics: finalizeCompileDiagnostics(context, {
      intensityApplied: context.intent.mode === "expressive"
        && context.settings.motionIntensityScale !== 1,
    }),
  };
}

function buildMotionBase(
  context: MotionCompileContext,
  diagnostics: CompileDiagnostics,
  payload:
    | Pick<Extract<CompiledSemanticMotion, { kind: "pose" }>, "kind" | "axes">
    | Pick<Extract<CompiledSemanticMotion, { kind: "sequence" }>, "kind" | "steps">,
): CompiledSemanticMotion {
  const profile = context.state.profile;
  const timing = context.state.timing;
  if (!profile || !timing) {
    throw new Error("semantic_compile_missing_required_state");
  }
  const base = {
    schemaVersion: "engine.compiled_semantic_motion.v1" as const,
    profileId: profile.profile_id,
    profileRevision: profile.revision,
    modelId: profile.model_id,
    mode: context.state.resolvedMode,
    emotionLabel: context.intent.emotion_label,
    intentTags: [...(context.intent.intent_tags ?? [])],
    performanceCurveHint: context.intent.performance_curve_hint,
    expressionResourceId: context.intent.schema_version === SCHEMA_MOTION_INTENT_V4
      ? context.intent.expression_resource_id
      : undefined,
    timing,
    diagnostics,
  };
  if (payload.kind === "pose") {
    return { ...base, kind: "pose", axes: payload.axes };
  }
  return { ...base, kind: "sequence", steps: payload.steps };
}

function failSemanticCompile(
  reason: string,
  context: MotionCompileContext,
  failureStage?: string,
): Extract<CompileSemanticMotionResult, { ok: false }> {
  return {
    ok: false,
    motion: null,
    reason,
    diagnostics: finalizeCompileDiagnostics(context, { failureStage }),
    feedback: {
      code: reason,
      message: reason,
      fields: [
        ...context.state.invalidAxes,
        ...context.state.forbiddenAxes,
      ],
    },
  };
}
