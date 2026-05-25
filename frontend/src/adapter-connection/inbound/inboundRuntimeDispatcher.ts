import type { ControlErrorPayload, ProtocolEnvelope } from "../../types/protocol.js";
import type { InboundAdapterEvent } from "./inboundEvents.js";
import type { PendingAssistantTextItem, PendingAudioItem } from "../runtime/playbackReleaseQueue.js";

export interface InboundRuntimeDispatchState {
  currentTurnId: string | null;
  statusMessage: string;
  lastError: string;
  turnFinishedTurnId: string | null;
  turnFinishedSuccess: boolean;
  turnFinishedReason: string;
  micRequested: boolean;
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
  stopAudioPlayback: () => void;
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
    deps.reportRuntimeProtocolViolation(
      error instanceof Error ? error.message : "turn_finished arrived for unknown session.",
    );
    return;
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
  if (s.audioPlaybackStartedMessageId) {
      deps.markAudioPlaybackTerminal(
        "failed",
        s.audioPlaybackStartedTurnId,
        "audio_playback_interrupted",
        s.audioPlaybackStartedMessageId,
      );
  }
  deps.stopAudioPlayback();
  deps.resetAudioPlaybackTerminal();
  s.pendingAssistantTexts.clear();
  s.pendingAudios.clear();
  deps.sessionStore?.markInterrupt(event.turnId);
  s.currentTurnId = null;
  s.statusMessage = "当前轮次已中断。";
  deps.pushHistory("system", s.statusMessage);
}

function applyStartMic(deps: InboundRuntimeDispatchDeps): void {
  const s = deps.state;
  s.micRequested = true;
  s.statusMessage = "后端已请求启动麦克风，准备自动收音。";
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
    deps.reportRuntimeProtocolViolation(
      error instanceof Error ? error.message : "synth_finished arrived for unknown session.",
    );
    return;
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

function applyControlError(
  deps: InboundRuntimeDispatchDeps,
  envelope: ProtocolEnvelope<ControlErrorPayload>,
): void {
  const s = deps.state;
  s.lastError = envelope.payload.message;
  s.statusMessage = envelope.payload.message;
  deps.pushHistory("error", envelope.payload.message);
}
