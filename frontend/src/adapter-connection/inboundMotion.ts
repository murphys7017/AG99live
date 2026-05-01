import type { ProtocolEnvelope } from "../types/protocol";
import { SCHEMA_MOTION_INTENT_V2, SCHEMA_PARAMETER_PLAN_V2 } from "../types/protocol";

export interface InboundMotionState {
  currentTurnId: string | null;
  currentOrchestrationId: string | null;
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackStartedOrchestrationId: string | null;
  statusMessage: string;
  lastError: string;
  inboundMotionPlan: unknown;
  inboundMotionPlanTurnId: string | null;
  inboundMotionPlanOrchestrationId: string | null;
  inboundMotionPlanReceivedAtMs: number;
  inboundMotionPlanNonce: number;
}

export interface InboundMotionContext {
  state: InboundMotionState;
  pushHistory: (role: "system" | "error", text: string) => void;
}

function normalizeTurnIdForComparison(turnId: string | null | undefined): string {
  return typeof turnId === "string" ? turnId.trim() : "";
}

function normalizeOrchestrationId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

export function applyInboundMotionPayload(
  ctx: InboundMotionContext,
  envelope: ProtocolEnvelope<Record<string, unknown>>,
): void {
  const state = ctx.state;
  const envelopeTurnId = normalizeTurnIdForComparison(envelope.turn_id);
  const envelopeOrchestrationId = normalizeOrchestrationId(envelope.orchestration_id);
  const currentTurnId = normalizeTurnIdForComparison(state.currentTurnId);
  const currentOrchestrationId = normalizeOrchestrationId(state.currentOrchestrationId);
  const activeAudioTurnId = normalizeTurnIdForComparison(state.audioPlaybackStartedTurnId);
  const activeAudioOrchestrationId = normalizeOrchestrationId(state.audioPlaybackStartedOrchestrationId);
  console.info(
    "[Connection] engine motion payload received. type=",
    envelope.type,
    "turn_id=",
    envelopeTurnId,
    "currentTurnId=",
    currentTurnId,
    "orchestrationId=",
    envelopeOrchestrationId,
    "currentOrchestrationId=",
    currentOrchestrationId,
    "audioPlaybackStartedTurnId=",
    activeAudioTurnId,
    "audioPlaybackStartedOrchestrationId=",
    activeAudioOrchestrationId,
  );

  const matchesCurrentTurn = Boolean(
    envelopeTurnId
    && currentTurnId
    && envelopeTurnId === currentTurnId,
  );
  const matchesCurrentOrchestration = Boolean(
    envelopeOrchestrationId
    && currentOrchestrationId
    && envelopeOrchestrationId === currentOrchestrationId,
  );
  const matchesActiveAudioTurn = Boolean(
    envelopeTurnId
    && activeAudioTurnId
    && envelopeTurnId === activeAudioTurnId,
  );
  const matchesActiveAudioOrchestration = Boolean(
    envelopeOrchestrationId
    && activeAudioOrchestrationId
    && envelopeOrchestrationId === activeAudioOrchestrationId,
  );

  if (
    envelopeOrchestrationId
    && currentOrchestrationId
    && envelopeOrchestrationId !== currentOrchestrationId
    && !matchesActiveAudioOrchestration
  ) {
    console.warn(
      "[Connection] discarding motion payload for stale orchestration_id. envelope_orchestration_id=",
      envelopeOrchestrationId,
      "current_orchestration_id=",
      currentOrchestrationId,
    );
    state.statusMessage = `忽略过期动作计划（orchestration_id=${envelopeOrchestrationId}）。`;
    ctx.pushHistory("system", state.statusMessage);
    return;
  }

  if (
    envelopeTurnId
    && currentTurnId
    && envelopeTurnId !== currentTurnId
  ) {
    if (
      matchesActiveAudioTurn
      || matchesCurrentOrchestration
      || matchesActiveAudioOrchestration
    ) {
      console.info(
        "[Connection] accepting late motion payload for active turn/orchestration. envelope_turn_id=",
        envelopeTurnId,
        "current_turn_id=",
        currentTurnId,
      );
    } else {
    console.warn(
      "[Connection] discarding motion payload for stale turn_id. envelope_turn_id=",
      envelopeTurnId,
      "current_turn_id=",
      currentTurnId,
    );
      state.statusMessage = `忽略过期动作计划（turn_id=${envelopeTurnId}）。`;
      ctx.pushHistory("system", state.statusMessage);
      return;
    }
  }

  if (
    !matchesCurrentTurn
    && !matchesCurrentOrchestration
    && !matchesActiveAudioTurn
    && !matchesActiveAudioOrchestration
    && !currentTurnId
    && !currentOrchestrationId
    && !activeAudioTurnId
    && !activeAudioOrchestrationId
  ) {
    console.warn(
      "[Connection] discarding orphan motion payload with no active turn/orchestration context.",
      envelope,
    );
    state.statusMessage = "忽略孤立动作计划（当前无活跃文本/音频编排上下文）。";
    ctx.pushHistory("system", state.statusMessage);
    return;
  }

  const rawPayload = envelope.payload;
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const payloadKey = envelope.type === "engine.motion_intent" ? "intent" : "plan";
  const mode =
    typeof payload.mode === "string" && payload.mode.trim()
      ? payload.mode.trim()
      : "preview";
  const hasMotionPayload = Object.prototype.hasOwnProperty.call(payload, payloadKey);
  const plan = hasMotionPayload ? payload[payloadKey as keyof typeof payload] : null;

  console.info(
    "[Connection] engine motion payload parsed. type=",
    envelope.type,
    "payloadKey=",
    payloadKey,
    "hasMotionPayload=",
    hasMotionPayload,
    "plan type=",
    typeof plan,
    "plan keys=",
    plan && typeof plan === "object" ? Object.keys(plan as object) : "N/A",
  );

  if (!plan || typeof plan !== "object") {
    console.warn("[Connection] invalid motion payload envelope:", envelope);
    state.lastError = `收到无效的 ${envelope.type}（缺少 ${payloadKey} 对象）。`;
    state.statusMessage = state.lastError;
    ctx.pushHistory("error", state.lastError);
    return;
  }

  const schemaVersion =
    typeof (plan as Record<string, unknown>).schema_version === "string"
      ? String((plan as Record<string, unknown>).schema_version).trim()
      : "";
  const allowedSchemaVersions = envelope.type === "engine.motion_intent"
    ? new Set([SCHEMA_MOTION_INTENT_V2])
    : new Set([SCHEMA_PARAMETER_PLAN_V2]);
  if (!allowedSchemaVersions.has(schemaVersion)) {
    console.warn(
      "[Connection] motion payload schema mismatch.",
      "type=",
      envelope.type,
      "expected=",
      [...allowedSchemaVersions].join("|"),
      "actual=",
      schemaVersion,
      envelope,
    );
    state.lastError = `收到无效的 ${envelope.type}（schema_version=${schemaVersion || "empty"}）。`;
    state.statusMessage = state.lastError;
    ctx.pushHistory("error", state.lastError);
    return;
  }

  state.inboundMotionPlan = plan;
  state.inboundMotionPlanTurnId = envelopeTurnId || null;
  state.inboundMotionPlanOrchestrationId = envelopeOrchestrationId;
  state.inboundMotionPlanReceivedAtMs = performance.now();
  state.inboundMotionPlanNonce += 1;
  console.info("[Connection] inboundMotionPlanNonce incremented to", state.inboundMotionPlanNonce, "— watch should fire next.");
  state.statusMessage = `收到外部动作载荷（${envelope.type}, mode=${mode}）。`;
  ctx.pushHistory("system", state.statusMessage);
}
