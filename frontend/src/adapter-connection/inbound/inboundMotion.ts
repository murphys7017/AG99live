import type { ProtocolEnvelope } from "../../types/protocol.js";
import {
  SCHEMA_CATALOG_MOTION_V1,
  SCHEMA_MOTION_INTENT_V2,
} from "../../types/protocol.js";
import {
  normalizeTurnIdForComparison,
} from "../core/turnIds.js";

export interface InboundMotionState {
  currentTurnId: string | null;
  statusMessage: string;
  lastError: string;
  inboundMotionPlan: unknown;
  inboundMotionPlanTurnId: string | null;
  inboundMotionPlanReceivedAtMs: number;
}

export interface InboundMotionContext {
  state: InboundMotionState;
  activeAudioTurnId: string | null;
  pushHistory: (role: "system" | "error", text: string) => void;
}

export type InboundMotionApplyResult =
  | { accepted: false }
  | { accepted: true; rawPlan: Record<string, unknown> };

export function applyInboundMotionPayload(
  ctx: InboundMotionContext,
  envelope: ProtocolEnvelope<Record<string, unknown>>,
): InboundMotionApplyResult {
  const state = ctx.state;
  const envelopeTurnId = normalizeTurnIdForComparison(envelope.turn_id);
  const currentTurnId = normalizeTurnIdForComparison(state.currentTurnId);
  const activeAudioTurnId = normalizeTurnIdForComparison(ctx.activeAudioTurnId);
  console.info(
    "[Connection] engine motion payload received. type=",
    envelope.type,
    "turn_id=",
    envelopeTurnId,
    "currentTurnId=",
    currentTurnId,
    "activeAudioTurnId=",
    activeAudioTurnId,
  );

  const matchesCurrentTurn = Boolean(
    envelopeTurnId
    && currentTurnId
    && envelopeTurnId === currentTurnId,
  );
  const matchesActiveAudioTurn = Boolean(
    envelopeTurnId
    && activeAudioTurnId
    && envelopeTurnId === activeAudioTurnId,
  );

  if (
    envelopeTurnId
    && currentTurnId
    && envelopeTurnId !== currentTurnId
  ) {
    if (
      matchesActiveAudioTurn
    ) {
      console.info(
        "[Connection] accepting late motion payload for active turn. envelope_turn_id=",
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
      return { accepted: false };
    }
  }

  if (
    !matchesCurrentTurn
    && !matchesActiveAudioTurn
    && !currentTurnId
    && !activeAudioTurnId
  ) {
    console.warn(
      "[Connection] discarding orphan motion payload with no active turn context.",
      envelope,
    );
    state.statusMessage = "忽略孤立动作计划（当前无活跃 turn 上下文）。";
    ctx.pushHistory("system", state.statusMessage);
    return { accepted: false };
  }

  const rawPayload = envelope.payload;
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const payloadKey = envelope.type === "engine.catalog_motion" ? "motion" : "intent";
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
    return { accepted: false };
  }

  const schemaVersion =
    typeof (plan as Record<string, unknown>).schema_version === "string"
      ? String((plan as Record<string, unknown>).schema_version).trim()
      : "";
  const allowedSchemaVersions = new Set([
    SCHEMA_MOTION_INTENT_V2,
    SCHEMA_CATALOG_MOTION_V1,
  ]);
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
    return { accepted: false };
  }

  state.inboundMotionPlan = plan;
  state.inboundMotionPlanTurnId = envelopeTurnId || null;
  state.inboundMotionPlanReceivedAtMs = performance.now();
  state.statusMessage = `收到外部动作载荷（${envelope.type}, mode=${mode}）。`;
  ctx.pushHistory("system", state.statusMessage);
  return { accepted: true, rawPlan: plan as Record<string, unknown> };
}
