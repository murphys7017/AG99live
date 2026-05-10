import type {
  ControlErrorPayload,
  ControlTurnFinishedPayload,
  OutputAudioPayload,
  OutputImagePayload,
  OutputTextPayload,
  OutputTranscriptionPayload,
  ProtocolEnvelope,
  SystemHistoryCreatedPayload,
  SystemHistoryDataPayload,
  SystemHistoryDeletedPayload,
  SystemHistoryListPayload,
  SystemModelSyncPayload,
  SystemSemanticAxisProfileSavedPayload,
  SystemSemanticAxisProfileSaveFailedPayload,
  SystemServerInfoPayload,
} from "../types/protocol.js";
import { normalizeOrchestrationId } from "./orchestrationIds.js";
import { INBOUND_MESSAGE_TYPES } from "./protocolMessageTypes.js";
import {
  type PayloadParseError,
  parseControlErrorPayload,
  parseControlTurnFinishedPayload,
  parseHistoryCreatedPayload,
  parseHistoryDataPayload,
  parseHistoryDeletedPayload,
  parseHistoryListPayload,
  parseOutputAudioPayload,
  parseOutputImagePayload,
  parseOutputTextPayload,
  parseOutputTranscriptionPayload,
  parseSemanticAxisProfileSaveFailedPayload,
  parseSemanticAxisProfileSavedPayload,
  parseSystemServerInfoPayload,
} from "./inboundPayloads.js";

export interface InboundEventMappingContext {
  currentTurnId: string | null;
  currentOrchestrationId: string | null;
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackStartedOrchestrationId: string | null;
}

function normalizeTurnId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function resolveCurrentTurnIdentity(
  value: unknown,
  fallback: string | null,
): string | null {
  return normalizeTurnId(value) ?? fallback;
}

function resolveCurrentOrchestrationIdentity(
  value: unknown,
  fallback: string | null,
): string | null {
  return normalizeOrchestrationId(value) ?? fallback;
}

let legacySegmentSerial = 0;

function normalizeMessageId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function resolveMessageId(
  envelope: ProtocolEnvelope<unknown>,
  eventKind: string,
  turnId: string | null,
  orchestrationId: string | null,
): string {
  const messageId = normalizeMessageId(envelope.message_id);
  if (messageId) {
    return messageId;
  }
  legacySegmentSerial += 1;
  const groupId = orchestrationId || turnId || "anonymous";
  return `legacy:${eventKind}:${groupId}:${legacySegmentSerial}`;
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
  | { kind: "motion_tuning_samples_state"; envelope: ProtocolEnvelope<unknown> }
  | { kind: "history_list"; envelope: ProtocolEnvelope<SystemHistoryListPayload> }
  | { kind: "history_created"; envelope: ProtocolEnvelope<SystemHistoryCreatedPayload> }
  | { kind: "history_data"; envelope: ProtocolEnvelope<SystemHistoryDataPayload> }
  | { kind: "history_deleted"; envelope: ProtocolEnvelope<SystemHistoryDeletedPayload> }
  | { kind: "output_image"; envelope: ProtocolEnvelope<OutputImagePayload> }
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
    kind: "output_text";
    messageId: string;
    turnId: string | null;
    orchestrationId: string | null;
    text: string;
    envelope: ProtocolEnvelope<OutputTextPayload>;
  }
  | {
    kind: "output_audio";
    messageId: string;
    turnId: string | null;
    orchestrationId: string | null;
    text: string;
    audioUrl: string | null;
    envelope: ProtocolEnvelope<OutputAudioPayload>;
  }
  | {
    kind: "turn_started";
    turnId: string | null;
    orchestrationId: string | null;
    envelope: ProtocolEnvelope<unknown>;
  }
  | {
    kind: "turn_finished";
    turnId: string | null;
    orchestrationId: string | null;
    success: boolean;
    reason: string;
    envelope: ProtocolEnvelope<ControlTurnFinishedPayload>;
  }
  | {
    kind: "interrupt";
    turnId: string | null;
    orchestrationId: string | null;
    envelope: ProtocolEnvelope<unknown>;
  }
  | {
    kind: "synth_finished";
    turnId: string | null;
    orchestrationId: string | null;
    envelope: ProtocolEnvelope<unknown>;
  }
  | {
    kind: "engine_motion_payload";
    messageId: string;
    turnId: string | null;
    orchestrationId: string | null;
    envelope: ProtocolEnvelope<Record<string, unknown>>;
  };

export function mapInboundEnvelopeToEvent(
  envelope: ProtocolEnvelope<unknown>,
  ctx: InboundEventMappingContext,
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
      return {
        kind: "model_sync",
        envelope: envelope as ProtocolEnvelope<SystemModelSyncPayload>,
      };
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
      return {
        kind: "motion_tuning_samples_state",
        envelope,
      };
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
    case INBOUND_MESSAGE_TYPES.OUTPUT_TEXT: {
      const parsed = parseOutputTextPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      const payload = parsed.payload;
      const turnId = resolveCurrentTurnIdentity(envelope.turn_id, ctx.currentTurnId);
      const orchestrationId = resolveCurrentOrchestrationIdentity(
        envelope.orchestration_id,
        ctx.currentOrchestrationId,
      );
      return {
        kind: "output_text",
        messageId: resolveMessageId(envelope, "output_text", turnId, orchestrationId),
        turnId,
        orchestrationId,
        text: payload.text.trim(),
        envelope: withPayload(envelope, payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.OUTPUT_AUDIO: {
      const parsed = parseOutputAudioPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      const payload = parsed.payload;
      const normalizedAudioUrl =
        typeof payload.audio_url === "string" && payload.audio_url.trim()
          ? payload.audio_url.trim()
          : null;
      const turnId = resolveCurrentTurnIdentity(envelope.turn_id, ctx.currentTurnId);
      const orchestrationId = resolveCurrentOrchestrationIdentity(
        envelope.orchestration_id,
        ctx.currentOrchestrationId,
      );
      return {
        kind: "output_audio",
        messageId: resolveMessageId(envelope, "output_audio", turnId, orchestrationId),
        turnId,
        orchestrationId,
        text: payload.text.trim(),
        audioUrl: normalizedAudioUrl,
        envelope: withPayload(envelope, payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.OUTPUT_IMAGE: {
      const parsed = parseOutputImagePayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      return {
        kind: "output_image",
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
        orchestrationId: normalizeOrchestrationId(envelope.orchestration_id),
        envelope,
      };
    case INBOUND_MESSAGE_TYPES.CONTROL_TURN_FINISHED: {
      const parsed = parseControlTurnFinishedPayload(envelope);
      if (!parsed.ok) {
        return protocolPayloadError(envelope, parsed.error);
      }
      const payload = parsed.payload;
      return {
        kind: "turn_finished",
        turnId: resolveCurrentTurnIdentity(envelope.turn_id, ctx.currentTurnId),
        orchestrationId: resolveCurrentOrchestrationIdentity(
          envelope.orchestration_id,
          ctx.currentOrchestrationId,
        ),
        success: Boolean(payload.success),
        reason: payload.reason?.trim() ?? "",
        envelope: withPayload(envelope, payload),
      };
    }
    case INBOUND_MESSAGE_TYPES.CONTROL_INTERRUPT:
      return {
        kind: "interrupt",
        turnId: ctx.currentTurnId,
        orchestrationId: ctx.currentOrchestrationId,
        envelope,
      };
    case INBOUND_MESSAGE_TYPES.CONTROL_START_MIC:
      return {
        kind: "start_mic",
        envelope,
      };
    case INBOUND_MESSAGE_TYPES.CONTROL_SYNTH_FINISHED:
      return {
        kind: "synth_finished",
        turnId: resolveCurrentTurnIdentity(envelope.turn_id, ctx.currentTurnId),
        orchestrationId: resolveCurrentOrchestrationIdentity(
          envelope.orchestration_id,
          ctx.currentOrchestrationId,
        ),
        envelope,
      };
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
    case INBOUND_MESSAGE_TYPES.ENGINE_MOTION_PLAN:
    case INBOUND_MESSAGE_TYPES.ENGINE_MOTION_INTENT: {
      const turnId =
        normalizeTurnId(envelope.turn_id)
        ?? ctx.currentTurnId
        ?? ctx.audioPlaybackStartedTurnId;
      const orchestrationId =
        normalizeOrchestrationId(envelope.orchestration_id)
        ?? ctx.currentOrchestrationId
        ?? ctx.audioPlaybackStartedOrchestrationId;
      return {
        kind: "engine_motion_payload",
        messageId: resolveMessageId(envelope, "engine_motion_payload", turnId, orchestrationId),
        turnId,
        orchestrationId,
        envelope: envelope as ProtocolEnvelope<Record<string, unknown>>,
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
