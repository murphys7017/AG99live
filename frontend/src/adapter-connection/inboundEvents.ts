import type {
  ControlErrorPayload,
  ControlTurnFinishedPayload,
  OutputAudioPayload,
  OutputImagePayload,
  OutputTextPayload,
  OutputTranscriptionPayload,
  ProtocolEnvelope,
  SystemModelSyncPayload,
  SystemSemanticAxisProfileSavedPayload,
  SystemSemanticAxisProfileSaveFailedPayload,
  SystemServerInfoPayload,
} from "../types/protocol.js";
import { normalizeOrchestrationId } from "./orchestrationIds.js";

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
  | { kind: "history_list"; envelope: ProtocolEnvelope<Record<string, unknown>> }
  | { kind: "history_created"; envelope: ProtocolEnvelope<Record<string, unknown>> }
  | { kind: "history_data"; envelope: ProtocolEnvelope<Record<string, unknown>> }
  | { kind: "history_deleted"; envelope: ProtocolEnvelope<Record<string, unknown>> }
  | { kind: "output_image"; envelope: ProtocolEnvelope<OutputImagePayload> }
  | { kind: "output_transcription"; envelope: ProtocolEnvelope<OutputTranscriptionPayload> }
  | { kind: "control_error"; envelope: ProtocolEnvelope<ControlErrorPayload> }
  | { kind: "start_mic"; envelope: ProtocolEnvelope<unknown> }
  | { kind: "unhandled"; envelope: ProtocolEnvelope<unknown> };

export type InboundAdapterEvent =
  | InboundPassthroughEvent
  | {
    kind: "output_text";
    turnId: string | null;
    orchestrationId: string | null;
    text: string;
    envelope: ProtocolEnvelope<OutputTextPayload>;
  }
  | {
    kind: "output_audio";
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
    turnId: string | null;
    orchestrationId: string | null;
    envelope: ProtocolEnvelope<Record<string, unknown>>;
  };

export function mapInboundEnvelopeToEvent(
  envelope: ProtocolEnvelope<unknown>,
  ctx: InboundEventMappingContext,
): InboundAdapterEvent {
  switch (envelope.type) {
    case "system.server_info":
      return {
        kind: "server_info",
        envelope: envelope as ProtocolEnvelope<SystemServerInfoPayload>,
      };
    case "system.model_sync":
      return {
        kind: "model_sync",
        envelope: envelope as ProtocolEnvelope<SystemModelSyncPayload>,
      };
    case "system.semantic_axis_profile_saved":
      return {
        kind: "semantic_axis_profile_saved",
        envelope: envelope as ProtocolEnvelope<SystemSemanticAxisProfileSavedPayload>,
      };
    case "system.semantic_axis_profile_save_failed":
      return {
        kind: "semantic_axis_profile_save_failed",
        envelope: envelope as ProtocolEnvelope<SystemSemanticAxisProfileSaveFailedPayload>,
      };
    case "system.motion_tuning_samples_state":
      return {
        kind: "motion_tuning_samples_state",
        envelope,
      };
    case "system.history_list":
      return {
        kind: "history_list",
        envelope: envelope as ProtocolEnvelope<Record<string, unknown>>,
      };
    case "system.history_created":
      return {
        kind: "history_created",
        envelope: envelope as ProtocolEnvelope<Record<string, unknown>>,
      };
    case "system.history_data":
      return {
        kind: "history_data",
        envelope: envelope as ProtocolEnvelope<Record<string, unknown>>,
      };
    case "system.history_deleted":
      return {
        kind: "history_deleted",
        envelope: envelope as ProtocolEnvelope<Record<string, unknown>>,
      };
    case "output.text": {
      const payload = envelope.payload as OutputTextPayload;
      return {
        kind: "output_text",
        turnId: resolveCurrentTurnIdentity(envelope.turn_id, ctx.currentTurnId),
        orchestrationId: resolveCurrentOrchestrationIdentity(
          envelope.orchestration_id,
          ctx.currentOrchestrationId,
        ),
        text: payload.text.trim(),
        envelope: envelope as ProtocolEnvelope<OutputTextPayload>,
      };
    }
    case "output.audio": {
      const payload = envelope.payload as OutputAudioPayload;
      const normalizedAudioUrl =
        typeof payload.audio_url === "string" && payload.audio_url.trim()
          ? payload.audio_url.trim()
          : null;
      return {
        kind: "output_audio",
        turnId: resolveCurrentTurnIdentity(envelope.turn_id, ctx.currentTurnId),
        orchestrationId: resolveCurrentOrchestrationIdentity(
          envelope.orchestration_id,
          ctx.currentOrchestrationId,
        ),
        text: payload.text.trim(),
        audioUrl: normalizedAudioUrl,
        envelope: envelope as ProtocolEnvelope<OutputAudioPayload>,
      };
    }
    case "output.image":
      return {
        kind: "output_image",
        envelope: envelope as ProtocolEnvelope<OutputImagePayload>,
      };
    case "output.transcription":
      return {
        kind: "output_transcription",
        envelope: envelope as ProtocolEnvelope<OutputTranscriptionPayload>,
      };
    case "control.turn_started":
      return {
        kind: "turn_started",
        turnId: normalizeTurnId(envelope.turn_id),
        orchestrationId: normalizeOrchestrationId(envelope.orchestration_id),
        envelope,
      };
    case "control.turn_finished": {
      const payload = envelope.payload as ControlTurnFinishedPayload;
      return {
        kind: "turn_finished",
        turnId: resolveCurrentTurnIdentity(envelope.turn_id, ctx.currentTurnId),
        orchestrationId: resolveCurrentOrchestrationIdentity(
          envelope.orchestration_id,
          ctx.currentOrchestrationId,
        ),
        success: Boolean(payload.success),
        reason: payload.reason?.trim() ?? "",
        envelope: envelope as ProtocolEnvelope<ControlTurnFinishedPayload>,
      };
    }
    case "control.interrupt":
      return {
        kind: "interrupt",
        turnId: ctx.currentTurnId,
        orchestrationId: ctx.currentOrchestrationId,
        envelope,
      };
    case "control.start_mic":
      return {
        kind: "start_mic",
        envelope,
      };
    case "control.synth_finished":
      return {
        kind: "synth_finished",
        turnId: resolveCurrentTurnIdentity(envelope.turn_id, ctx.currentTurnId),
        orchestrationId: resolveCurrentOrchestrationIdentity(
          envelope.orchestration_id,
          ctx.currentOrchestrationId,
        ),
        envelope,
      };
    case "control.error":
      return {
        kind: "control_error",
        envelope: envelope as ProtocolEnvelope<ControlErrorPayload>,
      };
    case "engine.motion_plan":
    case "engine.motion_intent":
      return {
        kind: "engine_motion_payload",
        turnId:
          normalizeTurnId(envelope.turn_id)
          ?? ctx.currentTurnId
          ?? ctx.audioPlaybackStartedTurnId,
        orchestrationId:
          normalizeOrchestrationId(envelope.orchestration_id)
          ?? ctx.currentOrchestrationId
          ?? ctx.audioPlaybackStartedOrchestrationId,
        envelope: envelope as ProtocolEnvelope<Record<string, unknown>>,
      };
    default:
      return {
        kind: "unhandled",
        envelope,
      };
  }
}
