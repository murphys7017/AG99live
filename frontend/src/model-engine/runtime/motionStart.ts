import { compileMotionIntent } from "../compiler/compileMotionIntent.js";
import { createModelEngineStageRegistry } from "../compiler/registry.js";
import { MOTION_MIN_REMAINING_AUDIO_MS } from "../constants.js";
import type { NormalizedMotionPayload } from "../contracts.js";
import type { CompileDiagnostics } from "../compiler/contracts.js";
import type { MotionPlanPayload, SemanticMotionIntent } from "../../types/protocol.js";
import {
  resolvePerformanceCurveTimeline,
  resolvePlaybackTargetDurationMs,
  retimeSemanticParameterPlan,
} from "./playbackClock.js";
import type {
  ModelEngineStatus,
  MotionRuntimeStateController,
  MotionStartDependencies,
} from "./contracts.js";
import type { StartPayloadContext } from "./motionRuntimeScheduler.js";
import {
  buildSpeechOnlyCompilerIntent,
  type SpeechOnlyMotionRequest,
} from "./speechOnlyMotion.js";

export interface PreparedSemanticMotionPayload {
  modelPath: string;
  plan: MotionPlanPayload;
  diagnostics: CompileDiagnostics;
}

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
    startReason: context.startReason,
    queuedDelayMs: context.queuedDelayMs,
  });

  if (payload.kind === "semantic_intent") {
    return startCompilableMotionPayload(
      payload,
      context,
      dependencies,
      state,
      preparedSemanticMotion,
    );
  }
  if (payload.kind === "catalog_motion") {
    return startCatalogMotionPayload(payload, context, dependencies, state);
  }

  return startDirectPlanPayload(payload, context, dependencies, state);
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
  return timeline?.source === "audio" && timeline.phase !== "terminal";
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
  state.setState("compiling", "正在编译动作意图...", null);
  let targetDurationMs = resolveMotionTargetDurationMs(context);
  let speechActive = isSpeechActiveForPayload(context);
  const intent = resolveCompilerIntent(payload);
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
      state.setLastCompileReason(failureReason);
      state.setState("failed", `动作意图无法使用表演曲线：${curveTimeline.reason}`, null);
      state.pushHistory("error", `动作意图无法使用表演曲线：${curveTimeline.reason}`);
      return null;
    }
  }
  const compileResult = compileMotionIntent(intent, {
    model: selectedModel,
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

  console.info("[ModelEngine] semantic intent prepared.", {
    parameterCount: compileResult.plan.parameters.length,
    diagnostics: compileResult.diagnostics,
    messageId: context.messageId,
    turnId: context.turnId,
  });
  state.setState("pending", "动作计划已准备，等待音频起播。", compileResult.diagnostics);
  return {
    modelPath,
    plan: compileResult.plan,
    diagnostics: compileResult.diagnostics,
  };
}

function resolveCompilerIntent(payload: CompilableMotionPayload): SemanticMotionIntent {
  return payload.kind === "speech_only"
    ? buildSpeechOnlyCompilerIntent(payload.request)
    : payload.intent;
}

function startCatalogMotionPayload(
  payload: Extract<NormalizedMotionPayload, { kind: "catalog_motion" }>,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
): boolean {
  const selectedModel = dependencies.getSelectedModel();
  let notifiedStarted = false;
  const started = dependencies.playCatalogMotion(payload.motion, selectedModel, {
    onStarted: (_motion, runId) => {
      const normalizedRunId = normalizeMotionRunId(runId);
      if (!normalizedRunId) {
        return;
      }
      notifiedStarted = true;
      dependencies.onPlanStarted({
        motion: payload.motion,
        model: selectedModel,
        messageId: context.messageId,
        turnId: context.turnId,
        playbackTurnId: context.playbackTurnId,
        startReason: context.startReason,
        queuedDelayMs: context.queuedDelayMs,
        payloadKind: payload.kind,
        diagnostics: null,
        playerMessage: buildSuccessMessage(context, dependencies),
        runId: normalizedRunId,
      });
    },
  });
  if (!started) {
    const failureReason = dependencies.getPlayerMessage?.()
      || "现成 motion 被运行时拒绝执行。";
    state.setLastCompileReason(failureReason);
    state.setState("failed", failureReason, null);
    state.pushHistory("error", `动作播放失败：${failureReason}`);
    return false;
  }

  const successMessage = buildSuccessMessage(context, dependencies);
  if (!notifiedStarted) {
    return rejectMotionStartWithoutRunId(state, null);
  }
  state.setState("playing", successMessage, null);
  state.pushHistory("system", `现成 motion 执行中（${successMessage}）。`);
  return true;
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
    if (context.playbackClock?.source === "audio") {
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

  if (payload.kind === "semantic_intent" && prepared.plan.resource?.kind === "motion") {
    return startCompiledMotionResource(
      payload,
      prepared.plan,
      prepared.diagnostics,
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
      softHandoff: true,
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
          startReason: context.startReason,
          queuedDelayMs: context.queuedDelayMs,
          payloadKind: payload.kind,
          diagnostics: prepared.diagnostics,
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

function startCompiledMotionResource(
  payload: Extract<NormalizedMotionPayload, { kind: "semantic_intent" }>,
  plan: MotionPlanPayload,
  diagnostics: CompileDiagnostics,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
): boolean {
  const resource = plan.resource;
  if (!resource || resource.kind !== "motion") {
    return false;
  }
  const selectedModel = dependencies.getSelectedModel();
  let notifiedStarted = false;
  const started = dependencies.playCatalogMotion(resource.motion, selectedModel, {
    onStarted: (_motion, runId) => {
      const normalizedRunId = normalizeMotionRunId(runId);
      if (!normalizedRunId) {
        return;
      }
      notifiedStarted = true;
      dependencies.onPlanStarted({
        intent: payload.intent,
        plan,
        model: selectedModel,
        messageId: context.messageId,
        turnId: context.turnId,
        playbackTurnId: context.playbackTurnId,
        startReason: context.startReason,
        queuedDelayMs: context.queuedDelayMs,
        payloadKind: payload.kind,
        diagnostics,
        playerMessage: buildSuccessMessage(context, dependencies),
        runId: normalizedRunId,
      });
    },
  });
  if (!started) {
    const failureReason = dependencies.getPlayerMessage?.()
      || `完整动作资源执行失败：${resource.resource_id}`;
    state.setLastCompileReason(failureReason);
    state.setState("failed", failureReason, diagnostics);
    state.pushHistory("error", failureReason);
    return false;
  }
  const successMessage = buildSuccessMessage(context, dependencies);
  if (!notifiedStarted) {
    return rejectMotionStartWithoutRunId(state, diagnostics);
  }
  state.setState("playing", successMessage, diagnostics);
  state.pushHistory("system", `完整动作资源执行中（${successMessage}）。`);
  return true;
}

function startDirectPlanPayload(
  payload: Extract<NormalizedMotionPayload, { kind: "semantic_plan" }>,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
): boolean {
  const selectedModel = dependencies.getSelectedModel();
  if (payload.plan.resource?.kind === "motion") {
    return startDirectPlanMotionResource(
      payload,
      context,
      dependencies,
      state,
      selectedModel,
    );
  }
  let notifiedStarted = false;
  let playbackPlan: MotionPlanPayload;
  try {
    playbackPlan = retimeSemanticParameterPlan(
      payload.plan,
      resolveMotionTargetDurationMs(context),
    );
  } catch (error) {
    const reason = error instanceof Error
      ? `motion_plan_retime_failed:${error.message}`
      : "motion_plan_retime_failed";
    state.setLastCompileReason(reason);
    state.setState("failed", reason, null);
    state.pushHistory("error", `动作计划重定时失败：${reason}`);
    return false;
  }
  const started = dependencies.playPlan(
    playbackPlan,
    selectedModel,
    {
      softHandoff: true,
      onStarted: (plan, runId) => {
        const normalizedRunId = normalizeMotionRunId(runId);
        if (!normalizedRunId) {
          return;
        }
        notifiedStarted = true;
        dependencies.onPlanStarted({
          plan,
          model: selectedModel,
          messageId: context.messageId,
          turnId: context.turnId,
          playbackTurnId: context.playbackTurnId,
          startReason: context.startReason,
          queuedDelayMs: context.queuedDelayMs,
          payloadKind: payload.kind,
          diagnostics: null,
          playerMessage: buildSuccessMessage(context, dependencies),
          runId: normalizedRunId,
        });
      },
    },
  );

  if (!started) {
    const failureReason = dependencies.getPlayerMessage?.()
      || "动作计划被运行时拒绝执行。";
    state.setLastCompileReason(failureReason);
    state.setState("failed", failureReason, null);
    state.pushHistory("error", `动作播放失败：${failureReason}`);
    return false;
  }

  const successMessage = buildSuccessMessage(context, dependencies);
  if (!notifiedStarted) {
    return rejectMotionStartWithoutRunId(state, null);
  }

  state.setState("playing", successMessage, null);
  state.pushHistory("system", `动作计划执行中（${successMessage}）。`);
  return true;
}

function startDirectPlanMotionResource(
  payload: Extract<NormalizedMotionPayload, { kind: "semantic_plan" }>,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
  selectedModel: ReturnType<MotionStartDependencies["getSelectedModel"]>,
): boolean {
  const resource = payload.plan.resource;
  if (!resource || resource.kind !== "motion") {
    return false;
  }
  let notifiedStarted = false;
  const started = dependencies.playCatalogMotion(resource.motion, selectedModel, {
    onStarted: (_motion, runId) => {
      const normalizedRunId = normalizeMotionRunId(runId);
      if (!normalizedRunId) {
        return;
      }
      notifiedStarted = true;
      dependencies.onPlanStarted({
        plan: payload.plan,
        model: selectedModel,
        messageId: context.messageId,
        turnId: context.turnId,
        playbackTurnId: context.playbackTurnId,
        startReason: context.startReason,
        queuedDelayMs: context.queuedDelayMs,
        payloadKind: payload.kind,
        diagnostics: null,
        playerMessage: buildSuccessMessage(context, dependencies),
        runId: normalizedRunId,
      });
    },
  });
  if (!started) {
    const reason = dependencies.getPlayerMessage?.()
      || `完整动作资源执行失败：${resource.resource_id}`;
    state.setLastCompileReason(reason);
    state.setState("failed", reason, null);
    state.pushHistory("error", reason);
    return false;
  }
  const successMessage = buildSuccessMessage(context, dependencies);
  if (!notifiedStarted) {
    return rejectMotionStartWithoutRunId(state, null);
  }
  state.setState("playing", successMessage, null);
  state.pushHistory("system", `完整动作资源执行中（${successMessage}）。`);
  return true;
}

function buildSuccessMessage(
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
): string {
  return dependencies.getPlayerMessage?.()
    || `动作计划执行中（启动延迟 ${context.queuedDelayMs}ms）。`;
}
