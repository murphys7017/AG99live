/**
 * engine_motion_payload 入站事件着陆。
 *
 * 流程：
 *   1. findActiveAudioSegment 取出当前正在播音频段的 (turnId, messageId)，
 *      用作 inboundMotion 的对齐参考；
 *   2. applyInboundMotionPayload 做载荷校验与轮次匹配，并把成功的 rawPlan 写回 state；
 *   3. 若被接受，再用 normalizeMotionPayload 规范化为 NormalizedMotionPayload；
 *      规范化通过则 sessionStore.markMotionReceived，让播放编排器看到这份动作。
 * 任一步失败都安静地返回（applyInboundMotionPayload 内部会写错误状态/历史）。
 *
 * 边界：不发协议；动作的播放与段终态推进发生在播放管线和动作引擎里。
 */

import type { ProtocolEnvelope } from "../../types/protocol.js";
import type { NormalizedMotionPayload } from "../../model-engine/contracts.js";
import type { InboundAdapterEvent } from "./inboundEvents.js";
import type {
  InboundMotionApplyResult,
  InboundMotionContext,
} from "./inboundMotion.js";

export interface InboundMotionDispatchState {
  currentTurnId: string | null;
  statusMessage: string;
  lastError: string;
  inboundMotionPlan: unknown;
  inboundMotionPlanTurnId: string | null;
  inboundMotionPlanReceivedAtMs: number;
}

export interface InboundMotionDispatchDeps {
  state: InboundMotionDispatchState;
  sessionStore: {
    markMotionReceived: (
      turnId: string | null,
      payload: NormalizedMotionPayload,
      messageId: string,
    ) => void;
  } | undefined;
  pushHistory: (role: string, text: string) => void;
  findActiveAudioSegment: () => {
    turnId: string | null;
    messageId: string;
  } | null;
  normalizeMotionPayload: (payload: unknown) =>
    | { ok: true; payload: NormalizedMotionPayload }
    | { ok: false };
  applyInboundMotionPayload: (
    ctx: InboundMotionContext,
    envelope: ProtocolEnvelope<Record<string, unknown>>,
  ) => InboundMotionApplyResult;
}

type InboundMotionEvent = Extract<
  InboundAdapterEvent,
  { kind: "engine_motion_payload" }
>;
type InboundMotionPreviewEvent = Extract<
  InboundAdapterEvent,
  { kind: "engine_motion_preview" }
>;

export function dispatchInboundMotionEvent(
  deps: InboundMotionDispatchDeps,
  event: InboundMotionEvent,
): void {
  const activeAudioSegment = deps.findActiveAudioSegment();
  const result = deps.applyInboundMotionPayload({
    state: deps.state,
    activeAudioTurnId: activeAudioSegment?.turnId ?? null,
    pushHistory: deps.pushHistory as (role: "system" | "error", text: string) => void,
  }, event.envelope);
  if (!result.accepted) {
    return;
  }
  const normalized = deps.normalizeMotionPayload(result.rawPlan);
  if (normalized.ok) {
    deps.sessionStore?.markMotionReceived(
      event.turnId,
      normalized.payload,
      event.messageId,
    );
  }
}

export function dispatchInboundMotionPreviewEvent(
  deps: InboundMotionDispatchDeps & {
    playMotionPreviewPayload?: (payload: unknown) => boolean;
  },
  event: InboundMotionPreviewEvent,
): void {
  const payload = event.envelope.payload;
  const rawPlan =
    payload && typeof payload === "object" && "motion" in payload
      ? payload.motion
      : payload && typeof payload === "object" && "intent" in payload
        ? payload.intent
        : null;

  if (!rawPlan || typeof rawPlan !== "object") {
    deps.state.lastError = "收到无效的动作预览载荷（缺少 intent/motion 对象）。";
    deps.state.statusMessage = deps.state.lastError;
    deps.pushHistory("error", deps.state.lastError);
    return;
  }

  deps.state.inboundMotionPlan = rawPlan;
  deps.state.inboundMotionPlanTurnId = null;
  deps.state.inboundMotionPlanReceivedAtMs = performance.now();

  const played = deps.playMotionPreviewPayload?.(rawPlan) ?? false;
  if (!played) {
    deps.state.lastError = "动作预览播放失败。";
    deps.state.statusMessage = deps.state.lastError;
    deps.pushHistory("error", deps.state.lastError);
    return;
  }

  deps.state.statusMessage = "已播放动作预览。";
  deps.pushHistory("system", deps.state.statusMessage);
}
