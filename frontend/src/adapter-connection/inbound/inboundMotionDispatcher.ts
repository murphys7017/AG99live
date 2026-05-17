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
