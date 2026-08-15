import { compileParameterMotionIntent } from "../compiler/compileParameterMotionIntent.js";
import { createModelEngineStageRegistry } from "../compiler/registry.js";
import { resolveCatalogResource } from "../compiler/resourceCatalog.js";
import { buildBaseCompileDiagnostics } from "../compiler/diagnostics.js";
import { normalizeModelEngineSettings } from "../settings.js";
import { MOTION_MIN_REMAINING_AUDIO_MS } from "../constants.js";
import type { NormalizedMotionPayload } from "../../types/motion.js";
import {
  SEMANTIC_MOTION_TRANSFORM_VERSION,
  type CompileDiagnostics,
  type CompiledSemanticMotion,
} from "../../types/compiledSemanticMotion.js";
import type {
  CatalogMotionPayload,
  ModelSummary,
  MotionPlanPayload,
  SemanticMotionIntent,
} from "../../types/protocol.js";
import type {
  CatalogMotionStartResult,
} from "../../types/live2d-runtime.d.ts";
import {
  resolvePerformanceCurveTimeline,
  resolvePlaybackTargetDurationMs,
} from "./playbackClock.js";
import type {
  ModelEnginePlanStartedEvent,
  MotionRuntimeStateController,
  MotionStartDependencies,
} from "./contracts.js";
import type { StartPayloadContext } from "./motionRuntimeScheduler.js";
import {
  buildSpeechOnlyCompilerIntent,
  type SpeechOnlyMotionRequest,
} from "./speechOnlyMotion.js";

export type PreparedSemanticMotionPayload =
  | {
    kind: "parameter_plan";
    modelPath: string;
    profileId: string;
    profileRevision: number;
    profileSourceHash: string;
    plan: MotionPlanPayload;
    diagnostics: CompileDiagnostics;
    semanticMotion: CompiledSemanticMotion;
  }
  | {
    kind: "motion_resource";
    modelPath: string;
    profileId: string;
    profileRevision: number;
    profileSourceHash: string;
    resourceId: string;
    motion: CatalogMotionPayload;
    diagnostics: CompileDiagnostics;
    intent: SemanticMotionIntent;
  };

type SemanticIntentPayload = Extract<
  NormalizedMotionPayload,
  { kind: "semantic_intent" }
>;

interface SpeechOnlyPayload {
  kind: "speech_only";
  request: SpeechOnlyMotionRequest;
}

type CompilableMotionPayload = SemanticIntentPayload | SpeechOnlyPayload;

export function reportInvalidMotionPayload(
  reason: string,
  state: MotionRuntimeStateController,
): void {
  state.setLastCompileReason(reason);
  state.setState("failed", `动作载荷无效：${reason}`, null);
  state.pushHistory("error", `动作载荷无效：${reason}`);
}

const MOTION_PLAYER_RUN_ID_MISSING = "motion_player_started_without_run_id";

function normalizeMotionRunId(runId: string): string | null {
  const normalized = typeof runId === "string" ? runId.trim() : "";
  return normalized || null;
}

function rejectMotionStartWithoutRunId(
  state: MotionRuntimeStateController,
  diagnostics: CompileDiagnostics | null,
): false {
  state.setLastCompileReason(MOTION_PLAYER_RUN_ID_MISSING);
  state.setState("failed", MOTION_PLAYER_RUN_ID_MISSING, diagnostics);
  state.pushHistory("error", `动作播放失败：${MOTION_PLAYER_RUN_ID_MISSING}`);
  return false;
}

export function startNormalizedMotionPayload(
  payload: NormalizedMotionPayload,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
  preparedSemanticMotion: PreparedSemanticMotionPayload | null = null,
): boolean {
  state.setLastStartReason(context.startReason);
  console.info("[ModelEngine] starting motion payload.", {
    kind: payload.kind,
    messageId: context.messageId,
    turnId: context.turnId,
    playbackTurnId: context.playbackTurnId,
    playbackOrigin: context.playbackOrigin,
    startReason: context.startReason,
    queuedDelayMs: context.queuedDelayMs,
  });

  switch (payload.kind) {
    case "semantic_intent":
      return startCompilableMotionPayload(
        payload,
        context,
        dependencies,
        state,
        preparedSemanticMotion,
      );
    case "catalog_motion":
      return startCatalogMotionPayload(payload, context, dependencies, state);
    default: {
      const unsupportedPayload: never = payload;
      const unsupportedKind = String(
        (unsupportedPayload as { kind?: unknown }).kind ?? "unknown",
      );
      const reason = `normalized_motion_payload_kind_unsupported:${unsupportedKind}`;
      state.setLastCompileReason(reason);
      state.setState("failed", reason, null);
      state.pushHistory("error", `动作播放失败：${reason}`);
      return false;
    }
  }
}

export function startSpeechOnlyMotionRequest(
  request: SpeechOnlyMotionRequest,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
  preparedSemanticMotion: PreparedSemanticMotionPayload | null,
): boolean {
  return startCompilableMotionPayload(
    { kind: "speech_only", request },
    context,
    dependencies,
    state,
    preparedSemanticMotion,
  );
}

function resolveTimelineTargetDurationMs(
  context: StartPayloadContext,
): number | null {
  return resolvePlaybackTargetDurationMs(
    context.playbackClock,
    MOTION_MIN_REMAINING_AUDIO_MS,
  );
}

function resolveMotionTargetDurationMs(
  context: StartPayloadContext,
): number | null {
  return resolveTimelineTargetDurationMs(context);
}

function isSpeechActiveForPayload(
  context: StartPayloadContext,
): boolean {
  const timeline = context.playbackClock;
  if (timeline?.source === "audio_unavailable") {
    return false;
  }
  return (
    (timeline?.source === "audio" || timeline?.source === "audio_pending")
    && timeline.phase !== "terminal"
  );
}

export function prepareSemanticMotionPayload(
  payload: SemanticIntentPayload,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
): PreparedSemanticMotionPayload | null {
  return prepareCompilableMotionPayload(payload, context, dependencies, state);
}

export function prepareSpeechOnlyMotionRequest(
  request: SpeechOnlyMotionRequest,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
): PreparedSemanticMotionPayload | null {
  return prepareCompilableMotionPayload(
    { kind: "speech_only", request },
    context,
    dependencies,
    state,
  );
}

function prepareCompilableMotionPayload(
  payload: CompilableMotionPayload,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
): PreparedSemanticMotionPayload | null {
  const selectedModel = dependencies.getSelectedModel();
  if (!selectedModel) {
    state.setLastCompileReason("missing_selected_model");
    state.setState("failed", "动作意图无法编译：当前未选中模型。", null);
    state.pushHistory("error", "动作意图无法编译：当前未选中模型。");
    return null;
  }

  const modelPath = selectedModel.model_path.trim();
  if (payload.kind === "semantic_intent" && isMotionResourceIntent(payload.intent)) {
    return prepareMotionResourcePayload(
      payload.intent,
      selectedModel,
      modelPath,
      context,
      dependencies,
      state,
    );
  }
  state.setState("compiling", "正在编译动作意图...", null);
  let targetDurationMs = resolveMotionTargetDurationMs(context);
  let speechActive = isSpeechActiveForPayload(context);
  let intent = resolveCompilerIntent(payload);
  if (isMotionResourceIntent(intent)) {
    throw new Error("motion_resource_intent_reached_parameter_compiler");
  }
  const runtimeWarnings: string[] = [];
  const performanceCurveHint = intent.performance_curve_hint ?? null;
  if (performanceCurveHint) {
    const curveTimeline = resolvePerformanceCurveTimeline({
      hint: performanceCurveHint,
      clock: context.playbackClock ?? null,
      minRemainingDurationMs: MOTION_MIN_REMAINING_AUDIO_MS,
    });
    if (curveTimeline.ok) {
      targetDurationMs = curveTimeline.targetDurationMs;
      speechActive = curveTimeline.speechActive;
      runtimeWarnings.push(`performance_curve_timeline:${curveTimeline.clockSource}`);
    } else {
      const failureReason = `performance_curve_timeline_unavailable:${curveTimeline.reason}`;
      runtimeWarnings.push(`performance_curve_skipped:${curveTimeline.reason}`);
      console.warn("[ModelEngine] optional performance curve skipped.", {
        turnId: context.turnId,
        messageId: context.messageId,
        reason: failureReason,
      });
      intent = {
        ...intent,
        performance_curve_hint: undefined,
      };
    }
  }
  const compileResult = compileParameterMotionIntent(intent, {
    model: selectedModel,
    assistantText: context.assistantText,
    targetDurationMs,
    speechActive,
    source: context.startReason,
    settings: dependencies.getSettings(),
    runtimeWarnings,
    samplingIdentity: {
      turnId: context.turnId ?? "",
      messageId: context.messageId,
    },
  }, dependencies.stageRegistry ?? createModelEngineStageRegistry());

  state.setLastCompileReason(compileResult.reason);
  state.setLastCompileDiagnostics(compileResult.diagnostics);

  if (!compileResult.ok || !compileResult.plan) {
    console.warn("[ModelEngine] semantic intent compile failed.", {
      reason: compileResult.reason,
      diagnostics: compileResult.diagnostics,
    });
    const failureMessage = `动作意图编译失败：${compileResult.reason}`;
    const failureEventBase = {
      model: selectedModel,
      messageId: context.messageId,
      turnId: context.turnId,
      playbackTurnId: context.playbackTurnId,
      playbackOrigin: context.playbackOrigin,
      startReason: context.startReason,
      queuedDelayMs: context.queuedDelayMs,
      reason: compileResult.reason,
      diagnostics: compileResult.diagnostics,
      feedback: compileResult.feedback ?? null,
    };
    dependencies.onCompileFailed?.(
      payload.kind === "speech_only"
        ? {
            ...failureEventBase,
            payloadKind: "speech_only",
            request: payload.request,
          }
        : {
            ...failureEventBase,
            payloadKind: "semantic_intent",
            intent,
          },
    );
    state.setState("failed", failureMessage, compileResult.diagnostics);
    state.pushHistory("error", failureMessage);
    return null;
  }
  const profile = selectedModel.semantic_axis_profile;
  if (!profile) {
    throw new Error("compiled_motion_profile_identity_missing");
  }

  console.info("[ModelEngine] semantic intent prepared.", {
    parameterCount: compileResult.plan.parameters.length,
    diagnostics: compileResult.diagnostics,
    messageId: context.messageId,
    turnId: context.turnId,
  });
  state.setState("pending", "动作计划已准备，等待音频起播。", compileResult.diagnostics);
  return {
    kind: "parameter_plan",
    modelPath,
    profileId: profile.profile_id,
    profileRevision: profile.revision,
    profileSourceHash: profile.source_hash,
    plan: compileResult.plan,
    diagnostics: compileResult.diagnostics,
    semanticMotion: compileResult.semanticMotion!,
  };
}

function prepareMotionResourcePayload(
  intent: SemanticMotionIntent,
  selectedModel: ModelSummary,
  modelPath: string,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
): PreparedSemanticMotionPayload | null {
  const resourceId = intent.motion_resource_id?.trim();
  if (!resourceId) {
    throw new Error("motion_resource_preparation_requires_resource_id");
  }
  state.setState("compiling", "正在验证完整动作资源...", null);
  const settings = normalizeModelEngineSettings(dependencies.getSettings());
  const baseDiagnostics: CompileDiagnostics = {
    ...buildBaseCompileDiagnostics({
      model: selectedModel,
      source: context.startReason,
      settings,
    }, settings),
    resolvedMode: intent.mode,
  };
  const profile = selectedModel.semantic_axis_profile;
  if (
    !profile
    || profile.profile_id !== intent.profile_id
    || profile.revision !== intent.profile_revision
    || profile.model_id !== intent.model_id
  ) {
    return failMotionResourcePreparation(
      "motion_resource_semantic_profile_identity_mismatch",
      baseDiagnostics,
      intent,
      selectedModel,
      context,
      dependencies,
      state,
    );
  }
  const resolved = resolveCatalogResource(selectedModel, resourceId, "motion");
  if (!resolved.ok || resolved.resource.resourceType !== "motion") {
    return failMotionResourcePreparation(
      resolved.ok ? "motion_resource_resolution_invalid" : resolved.reason,
      baseDiagnostics,
      intent,
      selectedModel,
      context,
      dependencies,
      state,
    );
  }
  const diagnostics: CompileDiagnostics = {
    ...baseDiagnostics,
    transformTrace: {
      transformVersion: SEMANTIC_MOTION_TRANSFORM_VERSION,
      profileRevision: profile.revision,
      profileHash: profile.source_hash,
      rawAxes: {},
      motionResourceId: resourceId,
      resolvedResource: {
        resourceId: resolved.resource.resourceId,
        resourceType: "motion",
        parameterIds: [],
      },
      resolvedAxes: {},
      derivedAxes: {},
      constrainedAxes: {},
      relationAdjustments: [],
      relationEvaluations: [],
      compiledParameters: [],
    },
  };
  state.setLastCompileReason("");
  state.setLastCompileDiagnostics(diagnostics);
  state.setState("pending", "完整动作资源已准备，等待音频起播。", diagnostics);
  return {
    kind: "motion_resource",
    modelPath,
    profileId: profile.profile_id,
    profileRevision: profile.revision,
    profileSourceHash: profile.source_hash,
    resourceId: resolved.resource.resourceId,
    motion: resolved.resource.motion,
    diagnostics,
    intent,
  };
}

function failMotionResourcePreparation(
  reason: string,
  diagnostics: CompileDiagnostics,
  intent: SemanticMotionIntent,
  model: ModelSummary,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
): null {
  state.setLastCompileReason(reason);
  state.setLastCompileDiagnostics(diagnostics);
  state.setState("failed", `完整动作资源验证失败：${reason}`, diagnostics);
  state.pushHistory("error", `完整动作资源验证失败：${reason}`);
  dependencies.onCompileFailed?.({
    model,
    messageId: context.messageId,
    turnId: context.turnId,
    playbackTurnId: context.playbackTurnId,
    playbackOrigin: context.playbackOrigin,
    startReason: context.startReason,
    queuedDelayMs: context.queuedDelayMs,
    payloadKind: "semantic_intent",
    intent,
    reason,
    diagnostics,
    feedback: {
      code: reason,
      message: reason,
      fields: ["motion_resource_id"],
    },
  });
  return null;
}

function resolveCompilerIntent(payload: CompilableMotionPayload): SemanticMotionIntent {
  return payload.kind === "speech_only"
    ? buildSpeechOnlyCompilerIntent(payload.request)
    : payload.intent;
}

function isMotionResourceIntent(
  intent: SemanticMotionIntent,
): intent is Extract<SemanticMotionIntent, { motion_resource_id: string }> {
  return typeof intent.motion_resource_id === "string"
    && intent.motion_resource_id.trim().length > 0;
}

interface CatalogMotionExecutionOptions {
  motion: CatalogMotionPayload;
  selectedModel: ModelSummary | null;
  context: StartPayloadContext;
  dependencies: MotionStartDependencies;
  state: MotionRuntimeStateController;
  diagnostics: CompileDiagnostics | null;
  failureMessage: string;
  startedHistory: (successMessage: string) => string;
  buildStartedEvent: (
    runId: string,
    playerMessage: string,
  ) => ModelEnginePlanStartedEvent;
}

function startCatalogMotionExecution(
  options: CatalogMotionExecutionOptions,
): boolean {
  const {
    motion,
    selectedModel,
    context,
    dependencies,
    state,
    diagnostics,
  } = options;
  let notifiedStarted = false;

  const startResult: CatalogMotionStartResult = dependencies.playCatalogMotion(
    motion,
    selectedModel,
    {
      playbackClockReader: context.playbackClockReader,
      requiresPlaybackClock: context.playbackOrigin === "conversation",
      onStarted: (_motion, runId) => {
        const normalizedRunId = normalizeMotionRunId(runId);
        if (!normalizedRunId) {
          return;
        }
        notifiedStarted = true;
        const successMessage = buildSuccessMessage(context, dependencies);
        state.setState("playing", successMessage, diagnostics);
        state.pushHistory("system", options.startedHistory(successMessage));
        dependencies.onPlanStarted(
          options.buildStartedEvent(normalizedRunId, successMessage),
        );
      },
    },
  );

  if (startResult.status === "rejected") {
    const failureReason = startResult.reason.trim()
      || dependencies.getPlayerMessage?.()
      || options.failureMessage;
    state.setLastCompileReason(failureReason);
    state.setState("failed", failureReason, diagnostics);
    state.pushHistory("error", `动作播放失败：${failureReason}`);
    return false;
  }

  const runId = normalizeMotionRunId(startResult.runId);
  if (!runId) {
    return rejectMotionStartWithoutRunId(state, diagnostics);
  }
  return notifiedStarted
    ? true
    : rejectMotionStartWithoutRunId(state, diagnostics);
}

function startCatalogMotionPayload(
  payload: Extract<NormalizedMotionPayload, { kind: "catalog_motion" }>,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
): boolean {
  const selectedModel = dependencies.getSelectedModel();
  return startCatalogMotionExecution({
    motion: payload.motion,
    selectedModel,
    context,
    dependencies,
    state,
    diagnostics: null,
    failureMessage: "现成 motion 被运行时拒绝执行。",
    startedHistory: (successMessage) =>
      `现成 motion 执行中（${successMessage}）。`,
    buildStartedEvent: (runId, playerMessage) => ({
      motion: payload.motion,
      model: selectedModel,
      messageId: context.messageId,
      turnId: context.turnId,
      playbackTurnId: context.playbackTurnId,
      playbackOrigin: context.playbackOrigin,
      startReason: context.startReason,
      queuedDelayMs: context.queuedDelayMs,
      payloadKind: payload.kind,
      executionKind: "catalog_motion",
      diagnostics: null,
      playerMessage,
      runId,
    }),
  });
}

function startCompilableMotionPayload(
  payload: CompilableMotionPayload,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
  preparedSemanticMotion: PreparedSemanticMotionPayload | null,
): boolean {
  const selectedModel = dependencies.getSelectedModel();
  if (!selectedModel) {
    state.setLastCompileReason("missing_selected_model");
    state.setState("failed", "动作意图无法编译：当前未选中模型。", null);
    state.pushHistory("error", "动作意图无法编译：当前未选中模型。");
    return false;
  }
  let prepared = preparedSemanticMotion;
  if (!prepared) {
    if (
      context.playbackClock?.source === "audio"
      || context.playbackClock?.source === "audio_pending"
    ) {
      const reason = "motion_plan_not_prepared_before_audio_start";
      state.setLastCompileReason(reason);
      state.setState("failed", `动作启动失败：${reason}`, null);
      state.pushHistory("error", `动作启动失败：${reason}`);
      return false;
    }
    prepared = prepareCompilableMotionPayload(
      payload,
      context,
      dependencies,
      state,
    );
    if (!prepared) {
      return false;
    }
  }
  if (selectedModel.model_path.trim() !== prepared.modelPath) {
    const reason = "prepared_motion_model_changed_before_start";
    state.setLastCompileReason(reason);
    state.setState("failed", `动作启动失败：${reason}`, prepared.diagnostics);
    state.pushHistory("error", `动作启动失败：${reason}`);
    return false;
  }
  const selectedProfile = selectedModel.semantic_axis_profile;
  if (
    !selectedProfile
    || selectedProfile.profile_id !== prepared.profileId
    || selectedProfile.revision !== prepared.profileRevision
    || selectedProfile.source_hash !== prepared.profileSourceHash
  ) {
    const reason = "prepared_motion_profile_changed_before_start";
    state.setLastCompileReason(reason);
    state.setState("failed", `动作启动失败：${reason}`, prepared.diagnostics);
    state.pushHistory("error", `动作启动失败：${reason}`);
    return false;
  }

  if (prepared.kind === "motion_resource") {
    return startMotionResourcePayload(
      prepared,
      context,
      dependencies,
      state,
    );
  }

  let notifiedStarted = false;
  const started = dependencies.playPlan(
    prepared.plan,
    selectedModel,
    {
      playbackClockReader: context.playbackClockReader,
      requiresPlaybackClock: context.playbackOrigin === "conversation",
      onStarted: (plan, runId) => {
        const normalizedRunId = normalizeMotionRunId(runId);
        if (!normalizedRunId) {
          return;
        }
        notifiedStarted = true;
        const eventBase = {
          plan,
          model: selectedModel,
          messageId: context.messageId,
          turnId: context.turnId,
          playbackTurnId: context.playbackTurnId,
          playbackOrigin: context.playbackOrigin,
          startReason: context.startReason,
          queuedDelayMs: context.queuedDelayMs,
          payloadKind: payload.kind,
          executionKind: "parameter_plan" as const,
          diagnostics: prepared.diagnostics,
          semanticMotion: prepared.semanticMotion,
          playerMessage: buildSuccessMessage(context, dependencies),
          runId: normalizedRunId,
        };
        dependencies.onPlanStarted(
          payload.kind === "speech_only"
            ? {
                ...eventBase,
                payloadKind: "speech_only",
                request: payload.request,
              }
            : {
                ...eventBase,
                payloadKind: "semantic_intent",
                intent: payload.intent,
              },
        );
      },
    },
  );

  if (!started) {
    const failureReason = dependencies.getPlayerMessage?.()
      || "动作意图编译成功，但运行时拒绝执行。";
    state.setState("failed", failureReason, prepared.diagnostics);
    state.pushHistory("error", `动作播放失败：${failureReason}`);
    return false;
  }

  const successMessage = buildSuccessMessage(context, dependencies);
  if (!notifiedStarted) {
    return rejectMotionStartWithoutRunId(state, prepared.diagnostics);
  }

  state.setState("playing", successMessage, prepared.diagnostics);
  state.pushHistory("system", `动作计划执行中（${successMessage}）。`);
  return true;
}

function startMotionResourcePayload(
  prepared: Extract<PreparedSemanticMotionPayload, { kind: "motion_resource" }>,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
): boolean {
  const selectedModel = dependencies.getSelectedModel();
  return startCatalogMotionExecution({
    motion: prepared.motion,
    selectedModel,
    context,
    dependencies,
    state,
    diagnostics: prepared.diagnostics,
    failureMessage: `完整动作资源执行失败：${prepared.resourceId}`,
    startedHistory: (successMessage) =>
      `完整动作资源执行中（${successMessage}）。`,
    buildStartedEvent: (runId, playerMessage) => ({
      intent: prepared.intent,
      motion: prepared.motion,
      model: selectedModel,
      messageId: context.messageId,
      turnId: context.turnId,
      playbackTurnId: context.playbackTurnId,
      playbackOrigin: context.playbackOrigin,
      startReason: context.startReason,
      queuedDelayMs: context.queuedDelayMs,
      payloadKind: "semantic_intent",
      executionKind: "motion_resource",
      diagnostics: prepared.diagnostics,
      playerMessage,
      runId,
    }),
  });
}

function buildSuccessMessage(
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
): string {
  return dependencies.getPlayerMessage?.()
    || `动作计划执行中（启动延迟 ${context.queuedDelayMs}ms）。`;
}
