/**
 * 输出类入站事件着陆：把 output_text / output_audio / output_image /
 * output_transcription 写到本地播放状态。
 *
 * 文本与音频要求段身份（turnId + messageId）；它们的 apply* 行为：
 *   - 用 queuePendingAssistantTextForPlayback / queuePendingAudioForPlayback
 *     把内容塞进 pending 队列（按 buildPendingPlaybackKey 复合键去重）；
 *   - 通过 sessionStore.markTextReceived / markAudioReceived 把同一份内容写到
 *     播放会话存储；
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
import type { PendingAssistantTextItem, PendingAudioItem } from "../runtime/playbackReleaseQueue.js";

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
    ) => void;
    markAudioReceived: (
      turnId: string | null,
      url: string,
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
  s.currentTurnId = event.turnId;
  const text = event.text;
  if (text) {
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
    );
  }
  s.lastError = "";
  s.statusMessage = text ? "已收到文本回复，等待同步播放。" : "已收到空文本回复。";
}

async function applyOutputAudio(
  deps: InboundOutputDispatchDeps,
  event: Extract<InboundAdapterEvent, { kind: "output_audio" }>,
): Promise<void> {
  const s = deps.state;
  s.currentTurnId = event.turnId;
  if (event.text) {
    const existingText = deps.sessionStore
      ?.ensureSegment(event.turnId, event.messageId)
      .text.content;
    if (!existingText) {
      deps.queuePendingAssistantTextForPlayback(
        s.pendingAssistantTexts,
        event.text,
        event.turnId,
        event.messageId,
      );
      deps.sessionStore?.markTextReceived(
        event.turnId,
        event.text,
        event.messageId,
        "replace",
      );
    }
  }

  if (!event.audioUrl) {
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
  ) ?? true;
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
