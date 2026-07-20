/**
 * 入站信封 → 内部判别联合事件的映射层。
 *
 * 上游 transport 已经把 socket 消息解析成 ProtocolEnvelope；本文件按 envelope.type
 * 把它折叠成 InboundAdapterEvent，并在折叠时：
 *   - 调用 inboundPayloads.* 做 payload 形状校验，失败返回 protocol_error 事件；
 *   - 把 turn_id 规范化（空串和非字符串都视为 null），并按事件类别选择归属；
 *   - segment 输出类与正式动作类事件强制要求非空 message_id/turn_id，缺失时返回 protocol_error；
 *   - turn_finished/synth_finished/interrupt 必须携带明确 turn_id，缺失时返回 protocol_error；
 *   - 未识别 envelope.type 返回 unhandled，由 dispatcher 走 diagnostics 上报。
 *
 * 自身不读写任何状态，也不调用副作用；纯函数式折叠，方便单元测试与缓冲重放。
 */

import type {
  ControlErrorPayload,
  ControlTurnFinishedPayload,
  OutputSegmentPayload,
  OutputTranscriptionPayload,
  ProtocolEnvelope,
  SystemHistoryCreatedPayload,
  SystemHistoryDataPayload,
  SystemHistoryDeletedPayload,
  SystemHistoryListPayload,
  SystemModelSyncPayload,
  SystemMotionTuningSamplesStatePayload,
  SystemMotionLabRawEventRecordedPayload,
  SystemSemanticAxisProfileSavedPayload,
  SystemSemanticAxisProfileSaveFailedPayload,
  SystemServerInfoPayload,
} from "../../types/protocol.js";
import { INBOUND_MESSAGE_TYPES } from "../core/protocolMessageTypes.js";
import {
  type PayloadParseError,
  parseControlErrorPayload,
  parseControlTurnFinishedPayload,
  parseHistoryCreatedPayload,
  parseHistoryDataPayload,
  parseHistoryDeletedPayload,
  parseHistoryListPayload,
  parseMotionTuningSamplesStatePayload,
  parseSystemMotionLabRawEventRecordedPayload,
  parseOutputSegmentPayload,
  parseOutputTranscriptionPayload,
  parseSemanticAxisProfileSaveFailedPayload,
  parseSemanticAxisProfileSavedPayload,
  parseSystemModelSyncPayload,
  parseSystemServerInfoPayload,
} from "./inboundPayloads.js";

/**
 * 映射上下文：折叠时提供当前运行现场；不为 segment/control 事件补缺失身份。
 * 由 createAdapterInboundRuntime 在每次折叠前现场快照构造，不由本文件持有状态。
 */
export interface InboundEventMappingContext {
  currentTurnId: string | null;
}

function normalizeTurnId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function normalizeMessageId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function requireSegmentMessageId(
  envelope: ProtocolEnvelope<unknown>,
): { ok: true; messageId: string } | { ok: false; event: InboundAdapterEvent } {
  const messageId = normalizeMessageId(envelope.message_id);
  if (messageId) {
    return { ok: true, messageId };
  }
  return {
    ok: false,
    event: protocolPayloadError(envelope, {
      code: "invalid_payload",
      path: "message_id",
      message: `收到非法协议载荷（type=${envelope.type}, path=message_id, expected=non-empty string）。`,
    }),
  };
}

function requireSegmentTurnId(
  envelope: ProtocolEnvelope<unknown>,
): { ok: true; turnId: string } | { ok: false; event: InboundAdapterEvent } {
  const turnId = normalizeTurnId(envelope.turn_id);
  if (turnId) {
    return { ok: true, turnId };
  }
  return {
    ok: false,
    event: protocolPayloadError(envelope, {
      code: "invalid_payload",
      path: "turn_id",
      message: `收到非法协议载荷（type=${envelope.type}, path=turn_id, expected=non-empty string）。`,
    }),
  };
}

type InboundPassthroughEvent =
  | { kind: "server_info"; envelope: ProtocolEnvelope<SystemServerInfoPayload> }
  | { kind: "model_sync"; envelope: ProtocolEnvelope<SystemModelSyncPayload> }
  | {
    kind: "semantic_axis_profile_saved";
    envelope: ProtocolEnvelope<SystemSemanticAxisProfileSavedPayload>;
  }
  | {
    kind: "semantic_axis_profile_save_failed";
    envelope: ProtocolEnvelope<SystemSemanticAxisProfileSaveFailedPayload>;
  }
  | { kind: "motion_tuning_samples_state"; envelope: ProtocolEnvelope<SystemMotionTuningSamplesStatePayload> }
  | {
    kind: "motion_lab_raw_event_recorded";
    envelope: ProtocolEnvelope<SystemMotionLabRawEventRecordedPayload>;
  }
  | { kind: "history_list"; envelope: ProtocolEnvelope<SystemHistoryListPayload> }
  | { kind: "history_created"; envelope: ProtocolEnvelope<SystemHistoryCreatedPayload> }
  | { kind: "history_data"; envelope: ProtocolEnvelope<SystemHistoryDataPayload> }
  | { kind: "history_deleted"; envelope: ProtocolEnvelope<SystemHistoryDeletedPayload> }
  | { kind: "output_transcription"; envelope: ProtocolEnvelope<OutputTranscriptionPayload> }
  | { kind: "control_error"; envelope: ProtocolEnvelope<ControlErrorPayload> }
  | { kind: "start_mic"; envelope: ProtocolEnvelope<unknown> }
  | {
    kind: "protocol_error";
    envelope: ProtocolEnvelope<unknown>;
    error: PayloadParseError;
    warningKey: string;
  }
  | { kind: "unhandled"; envelope: ProtocolEnvelope<unknown> };

export type InboundAdapterEvent =
  | InboundPassthroughEvent
  | {
    kind: "output_segment";
    messageId: string;
    turnId: string;
    payload: OutputSegmentPayload;
    envelope: ProtocolEnvelope<OutputSegmentPayload>;
  }
  | {
    kind: "turn_started";
    turnId: string | null;
    envelope: ProtocolEnvelope<unknown>;
  }
  | {
    kind: "turn_finished";
    turnId: string | null;
    success: boolean;
    reason: string;
    envelope: ProtocolEnvelope<ControlTurnFinishedPayload>;
  }
  | {
    kind: "interrupt";
    turnId: string | null;
    envelope: ProtocolEnvelope<unknown>;
  }
  | {
    kind: "synth_finished";
    turnId: string | null;
    envelope: ProtocolEnvelope<unknown>;
  }
  ;

/**
 * 折叠一份 envelope。任何 payload 校验失败、message_id 缺失，都折叠为
 * protocol_error 事件（不抛异常），由上层 dispatcher 走 diagnostics 上报。
 * 默认分支返回 unhandled，给上层一次机会决定是否记日志。
 */
export function mapInboundEnvelopeToEvent(
  envelope: ProtocolEnvelope<unknown>,
  _ctx: InboundEventMappingContext,
): InboundAdapterEvent {
  switch (envelope.type) {
    case INBOUND_MESSAGE_TYPES.SYSTEM_SERVER_INFO: {
      const parsed = parseSystemServerInfoPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      return {
        kind: "server_info",
        envelope: withPayload(envelope, parsed.payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.SYSTEM_MODEL_SYNC:
      {
        const parsed = parseSystemModelSyncPayload(envelope);
        if (!parsed.ok) {
          return protocolPayloadError(envelope, parsed.error);
        }
        return {
          kind: "model_sync",
          envelope: withPayload(envelope, parsed.payload),
        };
      }
    case INBOUND_MESSAGE_TYPES.SYSTEM_SEMANTIC_AXIS_PROFILE_SAVED: {
      const parsed = parseSemanticAxisProfileSavedPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      return {
        kind: "semantic_axis_profile_saved",
        envelope: withPayload(envelope, parsed.payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.SYSTEM_SEMANTIC_AXIS_PROFILE_SAVE_FAILED: {
      const parsed = parseSemanticAxisProfileSaveFailedPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      return {
        kind: "semantic_axis_profile_save_failed",
        envelope: withPayload(envelope, parsed.payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.SYSTEM_MOTION_TUNING_SAMPLES_STATE:
      {
        const parsed = parseMotionTuningSamplesStatePayload(envelope);
        if (!parsed.ok) {
          return protocolPayloadError(envelope, parsed.error);
        }
        return {
          kind: "motion_tuning_samples_state",
          envelope: withPayload(envelope, parsed.payload),
        };
      }
    case INBOUND_MESSAGE_TYPES.SYSTEM_MOTION_LAB_RAW_EVENT_RECORDED: {
      const parsed = parseSystemMotionLabRawEventRecordedPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      return {
        kind: "motion_lab_raw_event_recorded",
        envelope: withPayload(envelope, parsed.payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.SYSTEM_HISTORY_LIST: {
      const parsed = parseHistoryListPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      return {
        kind: "history_list",
        envelope: withPayload(envelope, parsed.payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.SYSTEM_HISTORY_CREATED: {
      const parsed = parseHistoryCreatedPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      return {
        kind: "history_created",
        envelope: withPayload(envelope, parsed.payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.SYSTEM_HISTORY_DATA: {
      const parsed = parseHistoryDataPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      return {
        kind: "history_data",
        envelope: withPayload(envelope, parsed.payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.SYSTEM_HISTORY_DELETED: {
      const parsed = parseHistoryDeletedPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      return {
        kind: "history_deleted",
        envelope: withPayload(envelope, parsed.payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.OUTPUT_SEGMENT: {
      const parsed = parseOutputSegmentPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      const turnId = requireSegmentTurnId(envelope);
      if (!turnId.ok) {
        return turnId.event;
      }
      const messageId = requireSegmentMessageId(envelope);
      if (!messageId.ok) {
        return messageId.event;
      }
      return {
        kind: "output_segment",
        messageId: messageId.messageId,
        turnId: turnId.turnId,
        payload: parsed.payload,
        envelope: withPayload(envelope, parsed.payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.OUTPUT_TRANSCRIPTION: {
      const parsed = parseOutputTranscriptionPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      return {
        kind: "output_transcription",
        envelope: withPayload(envelope, parsed.payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.CONTROL_TURN_STARTED:
      return {
        kind: "turn_started",
        turnId: normalizeTurnId(envelope.turn_id),
        envelope,
      };
    case INBOUND_MESSAGE_TYPES.CONTROL_TURN_FINISHED: {
      const parsed = parseControlTurnFinishedPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      const payload = parsed.payload;
      const turnId = requireSegmentTurnId(envelope);
      if (!turnId.ok) {
        return turnId.event;
      }
      return {
        kind: "turn_finished",
        turnId: turnId.turnId,
        success: Boolean(payload.success),
        reason: payload.reason?.trim() ?? "",
        envelope: withPayload(envelope, payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.CONTROL_INTERRUPT:
      {
        const turnId = requireSegmentTurnId(envelope);
        if (!turnId.ok) {
          return turnId.event;
        }
        return {
          kind: "interrupt",
          turnId: turnId.turnId,
          envelope,
        };
      }
    case INBOUND_MESSAGE_TYPES.CONTROL_START_MIC:
      return {
        kind: "start_mic",
        envelope,
      };
    case INBOUND_MESSAGE_TYPES.CONTROL_SYNTH_FINISHED:
      {
        const turnId = requireSegmentTurnId(envelope);
        if (!turnId.ok) {
          return turnId.event;
        }
        return {
          kind: "synth_finished",
          turnId: turnId.turnId,
          envelope,
        };
      }
    case INBOUND_MESSAGE_TYPES.CONTROL_ERROR: {
      const parsed = parseControlErrorPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      return {
        kind: "control_error",
        envelope: withPayload(envelope, parsed.payload),
      };
    }
    default:
      return {
        kind: "unhandled",
        envelope,
      };
  }
}

function withPayload<TPayload>(
  envelope: ProtocolEnvelope<unknown>,
  payload: TPayload,
): ProtocolEnvelope<TPayload> {
  return {
    ...envelope,
    payload,
  };
}

function protocolPayloadError(
  envelope: ProtocolEnvelope<unknown>,
  error: PayloadParseError,
): Extract<InboundPassthroughEvent, { kind: "protocol_error" }> {
  return {
    kind: "protocol_error",
    envelope,
    error,
    warningKey: `payload:${envelope.type}:${error.path}`,
  };
}
