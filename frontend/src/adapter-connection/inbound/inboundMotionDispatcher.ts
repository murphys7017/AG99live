import type { InboundAdapterEvent } from "./inboundEvents.js";

export interface InboundMotionPreviewDispatchDeps {
  state: {
    statusMessage: string;
    lastError: string;
  };
  pushHistory: (role: string, text: string) => void;
  playMotionPreviewPayload?: (payload: unknown) => boolean;
}

type InboundMotionPreviewEvent = Extract<
  InboundAdapterEvent,
  { kind: "engine_motion_preview" }
>;

export function dispatchInboundMotionPreviewEvent(
  deps: InboundMotionPreviewDispatchDeps,
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
