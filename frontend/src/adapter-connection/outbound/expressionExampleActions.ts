import { OUTBOUND_MESSAGE_TYPES } from "../core/protocolMessageTypes.js";
import type { OutboundActionContext } from "./outboundActions.js";

export interface ExpressionExampleOverrideSavePayload {
  model_name: string;
  example_id: string;
  enabled: boolean;
  feedback: string;
  tags: string[];
}

export interface ExpressionExampleOverrideDeletePayload {
  model_name: string;
  example_id: string;
}

export function sendExpressionExampleOverrideSave(
  ctx: OutboundActionContext,
  payload: ExpressionExampleOverrideSavePayload,
): boolean {
  return ctx.outboundClient.send(
    OUTBOUND_MESSAGE_TYPES.SYSTEM_EXPRESSION_EXAMPLE_OVERRIDE_SAVE,
    payload,
  );
}

export function sendExpressionExampleOverrideDelete(
  ctx: OutboundActionContext,
  payload: ExpressionExampleOverrideDeletePayload,
): boolean {
  return ctx.outboundClient.send(
    OUTBOUND_MESSAGE_TYPES.SYSTEM_EXPRESSION_EXAMPLE_OVERRIDE_DELETE,
    payload,
  );
}
