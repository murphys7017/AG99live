/**
 * engine_motion_payload 入站事件着陆。
 *
 * 流程：
 *   1. applyInboundMotionPayload 做载荷校验，并把成功的 rawPlan 写回 state；
 *   2. 若被接受，再用 normalizeMotionPayload 规范化为 NormalizedMotionPayload；
 *   3. 已存在同段 text/audio 时写入 sessionStore.markMotionReceived；
 *      否则先进入 pending motion ingress，等同段 output_text/output_audio 建段后再 flush。
 * 任一步失败都安静地返回（applyInboundMotionPayload 内部会写错误状态/历史）。
 *
 * 边界：motion 归属只看协议里的 turn_id + message_id，不依赖当前音频状态；
 * 不创建孤儿播放段；动作的播放与段终态推进发生在播放管线和动作引擎里。
 */

import type { ProtocolEnvelope } from "../../types/protocol.js";
import type { PerformanceCurveHint } from "../../types/protocol.js";
import type { NormalizedMotionPayload } from "../../model-engine/contracts.js";
import { normalizePerformanceCurveHint } from "../../model-engine/normalize.js";
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
    markPerformanceCurveHintReceived: (
      turnId: string | null,
      hint: PerformanceCurveHint,
      messageId: string,
    ) => void;
  } | undefined;
  pushHistory: (role: string, text: string) => void;
  hasPlaybackSegment: (turnId: string | null, messageId: string) => boolean;
  canAcceptSegmentPatch: (turnId: string | null, messageId: string) => boolean;
  canQueuePendingMotionForTurn: (turnId: string | null) => boolean;
  queuePendingMotionForSegment: (
    turnId: string | null,
    messageId: string,
    payload: NormalizedMotionPayload,
  ) => void;
  rejectSegmentPatchWithoutOutput: (
    kind: string,
    turnId: string | null,
    messageId: string,
  ) => void;
  rejectSegmentPatchAfterSynthFinished: (
    kind: string,
    turnId: string | null,
    messageId: string,
  ) => void;
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
type InboundPerformanceCurveHintEvent = Extract<
  InboundAdapterEvent,
  { kind: "engine_performance_curve_hint" }
>;

export function dispatchInboundMotionEvent(
  deps: InboundMotionDispatchDeps,
  event: InboundMotionEvent,
): void {
  const result = deps.applyInboundMotionPayload({
    state: deps.state,
    pushHistory: deps.pushHistory as (role: "system" | "error", text: string) => void,
  }, event.envelope);
  if (!result.accepted) {
    return;
  }
  const normalized = deps.normalizeMotionPayload(result.rawPlan);
  if (normalized.ok) {
    if (!deps.canAcceptSegmentPatch(event.turnId, event.messageId)) {
      deps.rejectSegmentPatchAfterSynthFinished(
        "动作载荷",
        event.turnId,
        event.messageId,
      );
      return;
    }
    if (deps.hasPlaybackSegment(event.turnId, event.messageId)) {
      deps.sessionStore?.markMotionReceived(
        event.turnId,
        normalized.payload,
        event.messageId,
      );
      return;
    }
    if (!deps.canQueuePendingMotionForTurn(event.turnId)) {
      deps.rejectSegmentPatchWithoutOutput(
        "动作载荷",
        event.turnId,
        event.messageId,
      );
      return;
    }
    deps.queuePendingMotionForSegment(
      event.turnId,
      event.messageId,
      normalized.payload,
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

export function dispatchInboundPerformanceCurveHintEvent(
  deps: InboundMotionDispatchDeps,
  event: InboundPerformanceCurveHintEvent,
): void {
  const hint = normalizePerformanceCurveHint(event.envelope.payload);
  if (!hint) {
    deps.state.lastError = "收到无效的表演曲线提示。";
    deps.state.statusMessage = deps.state.lastError;
    deps.pushHistory("error", deps.state.lastError);
    return;
  }
  if (!deps.hasPlaybackSegment(event.turnId, event.messageId)) {
    deps.rejectSegmentPatchWithoutOutput(
      "表演曲线提示",
      event.turnId,
      event.messageId,
    );
    return;
  }
  if (!deps.canAcceptSegmentPatch(event.turnId, event.messageId)) {
    deps.rejectSegmentPatchAfterSynthFinished(
      "表演曲线提示",
      event.turnId,
      event.messageId,
    );
    return;
  }
  deps.sessionStore?.markPerformanceCurveHintReceived(
    event.turnId,
    hint,
    event.messageId,
  );
  deps.state.statusMessage = "收到表演曲线提示。";
  deps.pushHistory("system", deps.state.statusMessage);
}
