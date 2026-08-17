import type {
  OutputTranscriptionPayload,
  ProtocolEnvelope,
} from "../../types/protocol.js";
import type {
  MotionPayloadNormalizer,
  NormalizedMotionPayload,
} from "../../types/motion.js";
import type {
  OutputSegmentCommitResult,
  OutputSegmentMaterial,
} from "../../turn-playback/session.js";
import type { InboundAdapterEvent } from "./inboundEvents.js";

export interface InboundOutputDispatchState {
  statusMessage: string;
  lastError: string;
  lastTranscription: string;
  lastImageCount: number;
}

export interface InboundOutputDispatchDeps {
  state: InboundOutputDispatchState;
  sessionStore: {
    commitOutputSegment: (
      turnId: string | null,
      messageId: string,
      material: OutputSegmentMaterial,
    ) => OutputSegmentCommitResult;
  } | undefined;
  pushHistory: (role: string, text: string) => void;
  rewriteHttpUrl: (rawUrl: string | null) => string;
  normalizeMotionPayload: MotionPayloadNormalizer;
  reportOutputSegmentRejected: (
    message: string,
    envelope: ProtocolEnvelope<unknown>,
  ) => void;
}

type InboundOutputEvent = Extract<
  InboundAdapterEvent,
  { kind: "output_segment" } | { kind: "output_transcription" }
>;

export async function dispatchInboundOutputEvent(
  deps: InboundOutputDispatchDeps,
  event: InboundOutputEvent,
): Promise<void> {
  if (event.kind === "output_transcription") {
    applyOutputTranscription(deps, event.envelope);
    return;
  }
  applyOutputSegment(deps, event);
}

function applyOutputSegment(
  deps: InboundOutputDispatchDeps,
  event: Extract<InboundAdapterEvent, { kind: "output_segment" }>,
): void {
  if (!deps.sessionStore) {
    throw new Error("output_segment_session_store_unavailable");
  }

  const { payload } = event;
  const { state } = deps;
  let normalizedMotion: NormalizedMotionPayload | null = null;
  let rejectionReason: string | null = null;
  if (payload.motion.state === "present") {
    const normalized = deps.normalizeMotionPayload(payload.motion.payload);
    if (!normalized.ok) {
      rejectionReason = `output_segment_motion_invalid:${event.messageId}:${normalized.reason}`;
    } else {
      normalizedMotion = normalized.payload;
    }
  }

  const resolvedAudioUrl = rejectionReason === null && payload.audio.state === "present"
    ? deps.rewriteHttpUrl(payload.audio.url)
    : null;
  if (
    rejectionReason === null
    && payload.audio.state === "present"
    && (!resolvedAudioUrl || !resolvedAudioUrl.trim())
  ) {
    rejectionReason = `output_segment_audio_url_invalid:${event.messageId}`;
  }

  const material: OutputSegmentMaterial = rejectionReason !== null
    ? { state: "rejected", reason: rejectionReason }
    : {
        state: "accepted",
        text: payload.text,
        audio: payload.audio.state === "present"
          ? {
              state: "present",
              url: resolvedAudioUrl!,
            }
          : payload.audio,
        motion: payload.motion.state === "present"
          ? { state: "present", payload: normalizedMotion as NormalizedMotionPayload }
          : payload.motion,
        speech: payload.speech,
      };

  // SessionStore is the sole owner of the complete segment material.
  const commitResult = deps.sessionStore.commitOutputSegment(
    event.turnId,
    event.messageId,
    material,
  );
  if (commitResult.status === "rejected") {
    deps.reportOutputSegmentRejected(commitResult.reason, event.envelope);
    return;
  }
  if (material.state === "rejected") {
    deps.reportOutputSegmentRejected(material.reason, event.envelope);
    return;
  }

  state.lastImageCount = payload.images.length;
  const failures = [
    payload.text.state === "failed" ? `text:${payload.text.reason}` : "",
    payload.audio.state === "failed" ? `audio:${payload.audio.reason}` : "",
    payload.motion.state === "failed" ? `motion:${payload.motion.reason}` : "",
  ].filter(Boolean);
  state.lastError = failures.join("; ");
  state.statusMessage = failures.length > 0
    ? "已收到完整回复，但部分播放材料失败。"
    : "已收到完整回复，准备统一播放。";
}

function applyOutputTranscription(
  deps: InboundOutputDispatchDeps,
  envelope: ProtocolEnvelope<OutputTranscriptionPayload>,
): void {
  const text = envelope.payload.text.trim();
  if (!text) {
    return;
  }
  deps.state.lastTranscription = text;
  deps.state.statusMessage = "已收到语音转写。";
  deps.pushHistory("transcription", text);
}
