import type {
  OutputTranscriptionPayload,
  ProtocolEnvelope,
} from "../../types/protocol.js";
import type { NormalizedMotionPayload } from "../../playback-integrations/motionPayload.js";
import type { OutputSegmentMaterial } from "../../turn-playback/session.js";
import type { InboundAdapterEvent } from "./inboundEvents.js";
import type {
  PendingAssistantTextItem,
  PendingAudioItem,
} from "../../playback-timeline/playbackReleaseQueue.js";

export interface InboundOutputDispatchState {
  statusMessage: string;
  lastError: string;
  lastTranscription: string;
  lastImageCount: number;
  pendingAssistantTexts: Map<string, PendingAssistantTextItem>;
  pendingAudios: Map<string, PendingAudioItem>;
}

export interface InboundOutputDispatchDeps {
  state: InboundOutputDispatchState;
  sessionStore: {
    commitOutputSegment: (
      turnId: string | null,
      messageId: string,
      material: OutputSegmentMaterial,
    ) => void;
  } | undefined;
  pushHistory: (role: string, text: string) => void;
  rewriteHttpUrl: (rawUrl: string | null) => string;
  queuePendingAssistantTextForPlayback: (
    map: Map<string, PendingAssistantTextItem>,
    text: string,
    turnId: string | null,
    messageId: string,
  ) => void;
  queuePendingAudioForPlayback: (
    map: Map<string, PendingAudioItem>,
    url: string,
    turnId: string | null,
    messageId: string,
  ) => void;
  normalizeMotionPayload: (
    payload: unknown,
  ) => { ok: true; payload: NormalizedMotionPayload } | { ok: false };
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
  if (payload.motion.state === "present") {
    const normalized = deps.normalizeMotionPayload(payload.motion.payload);
    if (!normalized.ok) {
      throw new Error(`output_segment_motion_invalid:${event.messageId}`);
    }
    normalizedMotion = normalized.payload;
  }

  const resolvedAudioUrl = payload.audio.state === "present"
    ? deps.rewriteHttpUrl(payload.audio.url)
    : null;
  if (
    payload.audio.state === "present"
    && (!resolvedAudioUrl || !resolvedAudioUrl.trim())
  ) {
    throw new Error(`output_segment_audio_url_invalid:${event.messageId}`);
  }

  const material: OutputSegmentMaterial = {
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
  };

  // SessionStore commits the complete segment before any release queue is changed.
  deps.sessionStore.commitOutputSegment(event.turnId, event.messageId, material);

  if (payload.text.state === "present") {
    deps.queuePendingAssistantTextForPlayback(
      state.pendingAssistantTexts,
      payload.text.content,
      event.turnId,
      event.messageId,
    );
  }

  if (payload.audio.state === "present" && resolvedAudioUrl) {
    deps.queuePendingAudioForPlayback(
      state.pendingAudios,
      resolvedAudioUrl,
      event.turnId,
      event.messageId,
    );
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
