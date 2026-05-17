import { compileMotionIntent } from "../compiler/compileMotionIntent.js";
import type { NormalizedMotionPayload } from "../contracts.js";
import type { CompileDiagnostics } from "../compiler/contracts.js";
import type { MotionPlanPayload } from "../../types/protocol.js";
import type {
  ModelEngineStatus,
  MotionRuntimeStateController,
  MotionStartDependencies,
} from "./contracts.js";
import type { StartPayloadContext } from "./motionRuntimeScheduler.js";

export interface MotionStartRuntimeAccess {
  resolveMotionTargetDurationMs: (
    messageId: string | null,
    turnId: string | null,
    playbackTurnId?: string | null,
  ) => number | null;
}

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
  runtime: MotionStartRuntimeAccess,
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
    return startSemanticIntentPayload(payload, context, dependencies, runtime, state);
  }

  return startDirectPlanPayload(payload, context, dependencies, runtime, state);
}

function startSemanticIntentPayload(
  payload: Extract<NormalizedMotionPayload, { kind: "semantic_intent" }>,
  context: StartPayloadContext,
  dependencies: MotionStartDependencies,
  runtime: MotionStartRuntimeAccess,
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
  const compileResult = compileMotionIntent(payload.intent, {
    model: selectedModel,
    targetDurationMs: runtime.resolveMotionTargetDurationMs(
      context.messageId,
      context.turnId,
      context.playbackTurnId,
    ),
    source: context.startReason,
    settings: dependencies.getSettings(),
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

  let startedPlan: MotionPlanPayload | null = null;
  const started = dependencies.playPlan(
    compileResult.plan,
    selectedModel,
    {
      softHandoff: true,
      onStarted: (plan) => {
        startedPlan = plan;
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
  if (startedPlan) {
    dependencies.onPlanStarted?.({
      plan: startedPlan,
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
  runtime: MotionStartRuntimeAccess,
  state: MotionRuntimeStateController,
): boolean {
  const selectedModel = dependencies.getSelectedModel();
  let startedPlan: MotionPlanPayload | null = null;
  const started = dependencies.playPlan(
    payload.plan,
    selectedModel,
    {
      softHandoff: true,
      targetDurationMs: runtime.resolveMotionTargetDurationMs(
        context.messageId,
        context.turnId,
        context.playbackTurnId,
      ),
      onStarted: (plan) => {
        startedPlan = plan;
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
  if (startedPlan) {
    dependencies.onPlanStarted?.({
      plan: startedPlan,
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
