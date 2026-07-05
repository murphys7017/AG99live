/**
 * 入站运行时/控制事件的落地处理。
 *
 * 处理 6 类事件：turn_started / turn_finished / interrupt / start_mic /
 * synth_finished / control_error。各 apply* 函数按事件类型写 deps.state、同步
 * sessionStore、追加历史；并非每个事件都会触碰三者。
 *
 * 音频收口只发生在需要它的控制路径：interrupt 会按目标 turn 调
 * deps.stopAudioAndSettleTurn；synth_finished 会把本轮缺失音频标 absent；
 * turn_finished 只收口 turn 状态，不直接停播或结算音频段。
 *
 * 边界：不发协议、不解析信封、不直接持有 WebSocket；所有副作用都通过 deps 注入。
 */

import type { ControlErrorPayload, ProtocolEnvelope } from "../../types/protocol.js";
import type { InboundAdapterEvent } from "./inboundEvents.js";
import {
  matchesPlaybackGroup,
  type PendingAssistantTextItem,
  type PendingAudioItem,
} from "../../playback-timeline/playbackReleaseQueue.js";

export interface InboundRuntimeDispatchState {
  currentTurnId: string | null;
  statusMessage: string;
  lastError: string;
  turnFinishedTurnId: string | null;
  turnFinishedSuccess: boolean;
  turnFinishedReason: string;
  micRequested: boolean;
  pttModeEnabled: boolean;
  isPlayingAudio: boolean;
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackStartedMessageId: string | null;
  pendingAssistantTexts: Map<string, PendingAssistantTextItem>;
  pendingAudios: Map<string, PendingAudioItem>;
}

export interface InboundRuntimeDispatchDeps {
  state: InboundRuntimeDispatchState;
  sessionStore: {
    setActiveSession: (turnId: string | null) => void;
    markTurnStarted: (turnId: string | null) => void;
    markSynthFinished: (turnId: string | null) => void;
    markTurnFinished: (turnId: string | null, success: boolean, reason?: string) => void;
    markInterrupt: (turnId: string | null) => void;
  } | undefined;
  pushHistory: (role: string, text: string) => void;
  stopAudioAndSettleTurn: (turnId: string | null, reason: string) => void;
  resetAudioPlaybackTerminal: () => void;
  markAudioPlaybackTerminal: (
    terminalState: string,
    turnId: string | null,
    reason?: string,
    messageId?: string | null,
  ) => void;
  hasPendingAudioForTurn: (turnId: string | null) => boolean;
  markMissingAudiosForTurn: (
    turnId: string | null,
    reason: string,
  ) => void;
  startMicrophoneCapture: (origin?: "manual" | "ptt" | "auto") => Promise<boolean>;
  reportRuntimeProtocolViolation: (message: string) => void;
}

type InboundRuntimeEvent = Extract<
  InboundAdapterEvent,
  | { kind: "turn_started" }
  | { kind: "turn_finished" }
  | { kind: "interrupt" }
  | { kind: "start_mic" }
  | { kind: "synth_finished" }
  | { kind: "control_error" }
>;

/**
 * 运行时事件的内部 switch，按 event.kind 调对应 apply* 处理函数。
 *
 * 同步执行（applyStartMic 内部以 void 启动 startMicrophoneCapture，不 await）。
 * 不抛异常，单条事件失败不影响后续事件投递。
 */
export function dispatchInboundRuntimeEvent(
  deps: InboundRuntimeDispatchDeps,
  event: InboundRuntimeEvent,
): void {
  switch (event.kind) {
    case "turn_started":
      applyTurnStarted(deps, event);
      return;
    case "turn_finished":
      applyTurnFinished(deps, event);
      return;
    case "interrupt":
      applyInterrupt(deps, event);
      return;
    case "start_mic":
      applyStartMic(deps);
      return;
    case "synth_finished":
      applySynthFinished(deps, event);
      return;
    case "control_error":
      applyControlError(deps, event.envelope);
      return;
  }
}

function applyTurnStarted(
  deps: InboundRuntimeDispatchDeps,
  event: Extract<InboundAdapterEvent, { kind: "turn_started" }>,
): void {
  const s = deps.state;
  s.currentTurnId = event.turnId;
  deps.sessionStore?.setActiveSession(s.currentTurnId);
  deps.sessionStore?.markTurnStarted(s.currentTurnId);
  deps.resetAudioPlaybackTerminal();
  s.pendingAssistantTexts.clear();
  s.pendingAudios.clear();
  s.turnFinishedTurnId = null;
  s.turnFinishedSuccess = true;
  s.turnFinishedReason = "";
  s.statusMessage = "后端正在处理这一轮对话。";
  deps.pushHistory("system", s.statusMessage);
}

function applyTurnFinished(
  deps: InboundRuntimeDispatchDeps,
  event: Extract<InboundAdapterEvent, { kind: "turn_finished" }>,
): void {
  const s = deps.state;
  s.turnFinishedTurnId = event.turnId;
  s.turnFinishedSuccess = event.success;
  s.turnFinishedReason = event.reason;
  try {
    deps.sessionStore?.markTurnFinished(
      s.turnFinishedTurnId,
      s.turnFinishedSuccess,
      s.turnFinishedReason,
    );
  } catch (error) {
    if (isCurrentTurnEvent(s.currentTurnId, s.turnFinishedTurnId)) {
      deps.sessionStore?.markTurnStarted(s.turnFinishedTurnId);
      deps.sessionStore?.markTurnFinished(
        s.turnFinishedTurnId,
        s.turnFinishedSuccess,
        s.turnFinishedReason,
      );
    } else {
      deps.reportRuntimeProtocolViolation(
        error instanceof Error ? error.message : "turn_finished arrived for unknown session.",
      );
      return;
    }
  }

  if (event.success) {
    s.statusMessage = "本轮对话已完成。";
    s.lastError = "";
    deps.pushHistory("system", s.statusMessage);
    return;
  }

  s.statusMessage = event.reason
    ? `本轮结束：${event.reason}`
    : "本轮对话未正常完成。";
  deps.pushHistory("system", s.statusMessage);
}

function applyInterrupt(
  deps: InboundRuntimeDispatchDeps,
  event: Extract<InboundAdapterEvent, { kind: "interrupt" }>,
): void {
  const s = deps.state;
  const interruptedTurnId = event.turnId;
  deps.stopAudioAndSettleTurn(interruptedTurnId, "audio_playback_interrupted");
  deps.resetAudioPlaybackTerminal();
  deletePendingItemsForTurn(s.pendingAssistantTexts, interruptedTurnId);
  deletePendingItemsForTurn(s.pendingAudios, interruptedTurnId);
  deps.sessionStore?.markInterrupt(interruptedTurnId);
  if (matchesTurn(s.currentTurnId, interruptedTurnId)) {
    s.currentTurnId = null;
  }
  s.statusMessage = "当前轮次已中断。";
  deps.pushHistory("system", s.statusMessage);
}

function applyStartMic(deps: InboundRuntimeDispatchDeps): void {
  const s = deps.state;
  if (s.pttModeEnabled) {
    s.statusMessage = "当前为按键说话模式，已忽略自动收音请求。";
    deps.pushHistory("system", s.statusMessage);
    return;
  }
  s.statusMessage = "后端已请求启动麦克风，准备自动收音。";
  s.micRequested = true;
  deps.pushHistory("system", s.statusMessage);
  void deps.startMicrophoneCapture("auto");
}

function applySynthFinished(
  deps: InboundRuntimeDispatchDeps,
  event: Extract<InboundAdapterEvent, { kind: "synth_finished" }>,
): void {
  const s = deps.state;
  try {
    deps.sessionStore?.markSynthFinished(event.turnId);
  } catch (error) {
    if (isCurrentTurnEvent(s.currentTurnId, event.turnId)) {
      deps.sessionStore?.markTurnStarted(event.turnId);
      deps.sessionStore?.markSynthFinished(event.turnId);
    } else {
      deps.reportRuntimeProtocolViolation(
        error instanceof Error ? error.message : "synth_finished arrived for unknown session.",
      );
      return;
    }
  }
  deps.markMissingAudiosForTurn(
    event.turnId,
    "synth_finished_without_audio_playback",
  );
  s.statusMessage =
    s.isPlayingAudio || deps.hasPendingAudioForTurn(event.turnId)
      ? "语音已准备同步播放。"
      : "语音合成已完成。";
  deps.pushHistory("system", s.statusMessage);
}

function isCurrentTurnEvent(
  currentTurnId: string | null,
  eventTurnId: string | null,
): boolean {
  return Boolean(currentTurnId && eventTurnId && currentTurnId === eventTurnId);
}

function deletePendingItemsForTurn<TItem extends { turnId: string | null }>(
  pendingItems: Map<string, TItem>,
  turnId: string | null,
): void {
  for (const [key, item] of Array.from(pendingItems.entries())) {
    if (matchesTurn(item.turnId, turnId)) {
      pendingItems.delete(key);
    }
  }
}

function matchesTurn(
  candidateTurnId: string | null,
  targetTurnId: string | null,
): boolean {
  if (matchesPlaybackGroup(candidateTurnId, targetTurnId)) {
    return true;
  }
  return !candidateTurnId && !targetTurnId;
}

function applyControlError(
  deps: InboundRuntimeDispatchDeps,
  envelope: ProtocolEnvelope<ControlErrorPayload>,
): void {
  const s = deps.state;
  s.lastError = envelope.payload.message;
  s.statusMessage = envelope.payload.message;
  deps.pushHistory("error", envelope.payload.message);
}
