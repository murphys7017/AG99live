import { compileMotionIntent } from "../compiler/compileMotionIntent.js";
import { MOTION_MIN_REMAINING_AUDIO_MS } from "../constants.js";
import type { NormalizedMotionPayload } from "../contracts.js";
import type { CompileDiagnostics } from "../compiler/contracts.js";
import type { MotionPlanPayload } from "../../types/protocol.js";
import { resolvePerformanceCurveTimeline } from "../../playback-timeline/performanceCurveSink.js";
import type {
  ModelEngineStatus,
  MotionRuntimeStateController,
  MotionStartDependencies,
} from "./contracts.js";
import type { StartPayloadContext } from "./motionRuntimeScheduler.js";

export function reportInvalidMotionPayload(
  reason: string,
  state: MotionRuntimeStateController,
): void {
  state.setLastCompileReason(reason);
  state.setState("failed", `动作载荷无效：${reason}`, null);
  state.pushHistory("error", `动作载荷无效：${reason}`);
}

export function startNormalizedMotionPayload(
  payload: NormalizedMotionPayload,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
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
    return startSemanticIntentPayload(payload, context, dependencies, state);
  }
  if (payload.kind === "catalog_motion") {
    return startCatalogMotionPayload(payload, context, dependencies, state);
  }

  return startDirectPlanPayload(payload, context, dependencies, state);
}

function resolveTimelineTargetDurationMs(
  context: StartPayloadContext,
): number | null {
  const timeline = context.playbackTimeline;
  if (!timeline) {
    return null;
  }
  if (timeline.clockSource === "audio_unavailable") {
    return null;
  }
  const durationMs = timeline.durationMs;
  if (
    typeof durationMs !== "number"
    || !Number.isFinite(durationMs)
    || durationMs <= 0
  ) {
    return null;
  }

  if (timeline.phase === "playing" || timeline.phase === "paused") {
    const currentTimeMs = Number.isFinite(timeline.currentTimeMs)
      ? Math.max(0, timeline.currentTimeMs)
      : 0;
    return Math.max(
      MOTION_MIN_REMAINING_AUDIO_MS,
      Math.round(durationMs - currentTimeMs),
    );
  }

  return Math.round(durationMs);
}

function resolveMotionTargetDurationMs(
  context: StartPayloadContext,
): number | null {
  return resolveTimelineTargetDurationMs(context);
}

function isSpeechActiveForPayload(
  context: StartPayloadContext,
): boolean {
  const timeline = context.playbackTimeline;
  if (timeline?.clockSource === "audio_unavailable") {
    return false;
  }
  if (
    timeline?.clockSource === "audio"
    && (timeline.phase === "playing" || timeline.phase === "paused")
  ) {
    return true;
  }
  return false;
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
      notifiedStarted = true;
      dependencies.onPlanStarted?.({
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
        runId,
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
    dependencies.onPlanStarted?.({
      motion: payload.motion,
      model: selectedModel,
      messageId: context.messageId,
      turnId: context.turnId,
      playbackTurnId: context.playbackTurnId,
      startReason: context.startReason,
      queuedDelayMs: context.queuedDelayMs,
      payloadKind: payload.kind,
      diagnostics: null,
      playerMessage: successMessage,
    });
  }
  state.setState("playing", successMessage, null);
  state.pushHistory("system", `现成 motion 执行中（${successMessage}）。`);
  return true;
}

function startSemanticIntentPayload(
  payload: Extract<NormalizedMotionPayload, { kind: "semantic_intent" }>,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
): boolean {
  const selectedModel = dependencies.getSelectedModel();
  if (!selectedModel) {
    state.setLastCompileReason("missing_selected_model");
    state.setState("failed", "动作意图无法编译：当前未选中模型。", null);
    state.pushHistory("error", "动作意图无法编译：当前未选中模型。");
    return false;
  }

  state.setState("compiling", "正在编译动作意图...", null);
  let targetDurationMs = resolveMotionTargetDurationMs(context);
  let speechActive = isSpeechActiveForPayload(context);
  let intent = payload.intent;
  const runtimeWarnings: string[] = [];
  const performanceCurveHint = payload.intent.performance_curve_hint ?? null;
  if (performanceCurveHint) {
    const curveTimeline = resolvePerformanceCurveTimeline({
      hint: performanceCurveHint,
      timeline: context.playbackTimeline ?? null,
      minRemainingDurationMs: MOTION_MIN_REMAINING_AUDIO_MS,
    });
    if (curveTimeline.ok) {
      targetDurationMs = curveTimeline.targetDurationMs;
      speechActive = curveTimeline.speechActive;
      runtimeWarnings.push(`performance_curve_timeline:${curveTimeline.clockSource}`);
    } else {
      intent = {
        ...payload.intent,
      };
      delete intent.performance_curve_hint;
      runtimeWarnings.push(`performance_curve_skipped:${curveTimeline.reason}`);
    }
  }
  const compileResult = compileMotionIntent(intent, {
    model: selectedModel,
    targetDurationMs,
    speechActive,
    source: context.startReason,
    settings: dependencies.getSettings(),
    runtimeWarnings,
  });

  state.setLastCompileReason(compileResult.reason);
  state.setLastCompileDiagnostics(compileResult.diagnostics);

  if (!compileResult.ok || !compileResult.plan) {
    console.warn("[ModelEngine] semantic intent compile failed.", {
      reason: compileResult.reason,
      diagnostics: compileResult.diagnostics,
    });
    const failureMessage = `动作意图编译失败：${compileResult.reason}`;
    state.setState("failed", failureMessage, compileResult.diagnostics);
    state.pushHistory("error", failureMessage);
    return false;
  }

  console.info("[ModelEngine] semantic intent compiled.", {
    parameterCount: compileResult.plan.parameters.length,
    diagnostics: compileResult.diagnostics,
  });

  let notifiedStarted = false;
  const started = dependencies.playPlan(
    compileResult.plan,
    selectedModel,
    {
      softHandoff: true,
      onStarted: (plan, runId) => {
        notifiedStarted = true;
        dependencies.onPlanStarted?.({
          intent: payload.intent,
          plan,
          model: selectedModel,
          messageId: context.messageId,
          turnId: context.turnId,
          playbackTurnId: context.playbackTurnId,
          startReason: context.startReason,
          queuedDelayMs: context.queuedDelayMs,
          payloadKind: payload.kind,
          diagnostics: compileResult.diagnostics,
          playerMessage: buildSuccessMessage(context, dependencies),
          runId,
        });
      },
    },
  );

  if (!started) {
    const failureReason = dependencies.getPlayerMessage?.()
      || "动作意图编译成功，但运行时拒绝执行。";
    state.setState("failed", failureReason, compileResult.diagnostics);
    state.pushHistory("error", `动作播放失败：${failureReason}`);
    return false;
  }

  const successMessage = buildSuccessMessage(context, dependencies);
  if (!notifiedStarted) {
    dependencies.onPlanStarted?.({
      intent: payload.intent,
      plan: compileResult.plan,
      model: selectedModel,
      messageId: context.messageId,
      turnId: context.turnId,
      playbackTurnId: context.playbackTurnId,
      startReason: context.startReason,
      queuedDelayMs: context.queuedDelayMs,
      payloadKind: payload.kind,
      diagnostics: compileResult.diagnostics,
      playerMessage: successMessage,
    });
  }

  state.setState("playing", successMessage, compileResult.diagnostics);
  state.pushHistory("system", `动作计划执行中（${successMessage}）。`);
  return true;
}

function startDirectPlanPayload(
  payload: Extract<NormalizedMotionPayload, { kind: "semantic_plan" }>,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  state: MotionRuntimeStateController,
): boolean {
  const selectedModel = dependencies.getSelectedModel();
  let notifiedStarted = false;
  const started = dependencies.playPlan(
    payload.plan,
    selectedModel,
    {
      softHandoff: true,
      targetDurationMs: resolveMotionTargetDurationMs(context),
      onStarted: (plan, runId) => {
        notifiedStarted = true;
        dependencies.onPlanStarted?.({
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
          runId,
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
    dependencies.onPlanStarted?.({
      plan: payload.plan,
      model: selectedModel,
      messageId: context.messageId,
      turnId: context.turnId,
      playbackTurnId: context.playbackTurnId,
      startReason: context.startReason,
      queuedDelayMs: context.queuedDelayMs,
      payloadKind: payload.kind,
      diagnostics: null,
      playerMessage: successMessage,
    });
  }

  state.setState("playing", successMessage, null);
  state.pushHistory("system", `动作计划执行中（${successMessage}）。`);
  return true;
}

function buildSuccessMessage(
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
): string {
  return dependencies.getPlayerMessage?.()
    || `动作计划执行中（启动延迟 ${context.queuedDelayMs}ms）。`;
}
