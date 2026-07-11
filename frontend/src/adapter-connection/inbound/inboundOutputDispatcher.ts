/**
 * 输出类入站事件着陆：把 output_text / output_audio / output_image /
 * output_transcription 写到本地播放状态。
 *
 * 文本与音频要求段身份（turnId + messageId）；它们的 apply* 行为：
 *   - output_text 用 queuePendingAssistantTextForPlayback 把可见文本塞进 pending 队列；
 *   - output_audio 用 queuePendingAudioForPlayback 把音频塞进 pending 队列，
 *     payload.caption_text 只作为音频字幕写入 audio.captionText；
 *   - 通过 sessionStore.markTextReceived / markAudioReceived 写到播放会话存储；
 *   - markAudioReceived 返回 false（重复音频）时直接落"已忽略"状态，不再入队；
 *   - 音频段 audio_url 缺失时把段标 failed:missing_audio_url，避免 pending 漂在那。
 * 图片与转写只更新计数/快照与历史，不接入播放管线。
 *
 * 边界：不发协议、不持有 WebSocket、不解析信封；所有副作用通过 deps 注入。
 */

import type {
  OutputImagePayload,
  OutputTranscriptionPayload,
  ProtocolEnvelope,
} from "../../types/protocol.js";
import type { InboundAdapterEvent } from "./inboundEvents.js";
import type { PendingAssistantTextItem, PendingAudioItem } from "../../playback-timeline/playbackReleaseQueue.js";

export interface InboundOutputDispatchState {
  currentTurnId: string | null;
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
    markTextReceived: (
      turnId: string | null,
      text: string,
      messageId: string,
      mode?: string,
      audioExpected?: boolean,
    ) => void;
    markAudioReceived: (
      turnId: string | null,
      url: string,
      messageId: string,
      captionText?: string,
    ) => boolean;
    markTextDelivered: (
      turnId: string | null,
      messageId: string,
    ) => void;
    canAcceptOutputSegment: (
      turnId: string | null,
      messageId: string,
    ) => boolean;
    ensureSegment: (
      turnId: string | null,
      messageId: string,
    ) => { text: { content: string | null } };
  } | undefined;
  pushHistory: (role: string, text: string) => void;
  rewriteHttpUrl: (rawUrl: string | null) => string;
  markAudioPlaybackTerminal: (
    terminalState: string,
    turnId: string | null,
    reason?: string,
    messageId?: string | null,
  ) => void;
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
  flushPendingMotionForSegment: (
    turnId: string | null,
    messageId: string,
  ) => void;
  rejectOutputAfterSynthFinished: (
    kind: string,
    turnId: string | null,
    messageId: string,
  ) => void;
}

type InboundOutputEvent = Extract<
  InboundAdapterEvent,
  | { kind: "output_text" }
  | { kind: "output_audio" }
  | { kind: "output_image" }
  | { kind: "output_transcription" }
>;

/**
 * 输出事件的内部 switch。output_audio 是 async（保留扩展余地），其余同步执行。
 * 不抛异常，单条事件失败不影响后续事件投递。
 */
export async function dispatchInboundOutputEvent(
  deps: InboundOutputDispatchDeps,
  event: InboundOutputEvent,
): Promise<void> {
  switch (event.kind) {
    case "output_text":
      applyOutputText(deps, event);
      return;
    case "output_audio":
      await applyOutputAudio(deps, event);
      return;
    case "output_image":
      applyOutputImage(deps, event.envelope);
      return;
    case "output_transcription":
      applyOutputTranscription(deps, event.envelope);
      return;
  }
}

function applyOutputText(
  deps: InboundOutputDispatchDeps,
  event: Extract<InboundAdapterEvent, { kind: "output_text" }>,
): void {
  const s = deps.state;
  const text = event.text;
  if (text) {
    if (deps.sessionStore && !deps.sessionStore.canAcceptOutputSegment(event.turnId, event.messageId)) {
      deps.rejectOutputAfterSynthFinished("output.text", event.turnId, event.messageId);
      return;
    }
    s.currentTurnId = event.turnId;
    deps.queuePendingAssistantTextForPlayback(
      s.pendingAssistantTexts,
      text,
      event.turnId,
      event.messageId,
    );
    deps.sessionStore?.markTextReceived(
      event.turnId,
      text,
      event.messageId,
      "replace",
      event.audioExpected,
    );
    deps.flushPendingMotionForSegment(event.turnId, event.messageId);
  }
  s.lastError = "";
  s.statusMessage = text ? "已收到文本回复，等待同步播放。" : "已收到空文本回复。";
}

async function applyOutputAudio(
  deps: InboundOutputDispatchDeps,
  event: Extract<InboundAdapterEvent, { kind: "output_audio" }>,
): Promise<void> {
  const s = deps.state;
  if (deps.sessionStore && !deps.sessionStore.canAcceptOutputSegment(event.turnId, event.messageId)) {
    deps.rejectOutputAfterSynthFinished("output.audio", event.turnId, event.messageId);
    return;
  }
  s.currentTurnId = event.turnId;
  const existingText = deps.sessionStore
    ?.ensureSegment(event.turnId, event.messageId)
    .text.content;
  deps.flushPendingMotionForSegment(event.turnId, event.messageId);

  if (!event.audioUrl) {
    if (!existingText) {
      deps.sessionStore?.markTextDelivered(event.turnId, event.messageId);
    }
    s.statusMessage = "收到音频回复占位，未提供可播放地址。";
    deps.pushHistory("system", s.statusMessage);
    deps.markAudioPlaybackTerminal(
      "failed",
      event.turnId,
      "missing_audio_url",
      event.messageId,
    );
    return;
  }

  const resolvedUrl = deps.rewriteHttpUrl(event.audioUrl);
  const audioAccepted = deps.sessionStore?.markAudioReceived(
    event.turnId,
    resolvedUrl,
    event.messageId,
    event.captionText,
  ) ?? true;
  deps.flushPendingMotionForSegment(event.turnId, event.messageId);
  if (!existingText) {
    deps.sessionStore?.markTextDelivered(event.turnId, event.messageId);
  }
  console.info("[Connection] output audio received.", {
    turnId: event.turnId,
    messageId: event.messageId,
    audioAccepted,
    rawUrl: event.audioUrl,
    resolvedUrl,
  });
  if (!audioAccepted) {
    s.statusMessage = "收到重复语音回复，已忽略。";
    return;
  }
  deps.queuePendingAudioForPlayback(
    s.pendingAudios,
    resolvedUrl,
    event.turnId,
    event.messageId,
  );
}

function applyOutputImage(
  deps: InboundOutputDispatchDeps,
  envelope: ProtocolEnvelope<OutputImagePayload>,
): void {
  const s = deps.state;
  s.lastImageCount = envelope.payload.images.length;
  s.statusMessage = `收到 ${envelope.payload.images.length} 张图片回复。`;
  deps.pushHistory("system", s.statusMessage);
}

function applyOutputTranscription(
  deps: InboundOutputDispatchDeps,
  envelope: ProtocolEnvelope<OutputTranscriptionPayload>,
): void {
  const s = deps.state;
  const text = envelope.payload.text.trim();
  if (text) {
    s.lastTranscription = text;
    s.statusMessage = "已收到语音转写。";
    deps.pushHistory("transcription", text);
  }
}
