import type { StartAudioPlaybackOptions } from "./audioPlayback.js";

export interface AudioPlaybackState {
  isPlayingAudio: boolean;
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackStartedOrchestrationId: string | null;
  audioPlaybackStartedMessageId: string | null;
  audioPlaybackStartedAtMs: number;
  audioPlaybackDurationMs: number | null;
  statusMessage: string;
  currentOrchestrationId: string | null;
  lastError: string;
}

export interface AudioPlaybackSessionStore {
  markAudioStarted: (
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
    startedAtMs?: number | null,
    durationMs?: number | null,
  ) => void;
}

export interface AudioPlaybackContext {
  state: AudioPlaybackState;
  startAudio: (url: string, opts: StartAudioPlaybackOptions) => Promise<void>;
  stopAudioRuntime: () => void;
  pushHistory: (role: string, text: string) => void;
  markTerminal: (
    terminalState: "completed" | "failed" | "absent",
    turnId: string | null,
    orchestrationId: string | null,
    reason?: string,
    messageId?: string | null,
  ) => void;
  resetTerminal: () => void;
  sessionStore?: AudioPlaybackSessionStore;
}

export async function playAudioAndAcknowledge(
  ctx: AudioPlaybackContext,
  audioUrl: string,
  turnId: string | null,
  orchestrationId: string | null = ctx.state.currentOrchestrationId,
  messageId: string,
): Promise<void> {
  stopAudioPlayback(ctx);
  ctx.resetTerminal();
  ctx.state.isPlayingAudio = true;
  ctx.state.audioPlaybackStartedTurnId = null;
  ctx.state.audioPlaybackStartedOrchestrationId = null;
  ctx.state.audioPlaybackStartedMessageId = null;
  ctx.state.audioPlaybackStartedAtMs = 0;
  ctx.state.audioPlaybackDurationMs = null;
  ctx.state.statusMessage = "收到语音回复，正在播放。";
  ctx.pushHistory("system", ctx.state.statusMessage);

  try {
    await ctx.startAudio(audioUrl, {
      onLipSyncUnavailable: () => {
        ctx.pushHistory("system", "嘴型同步加载失败，音频播放将无对应张嘴动作。");
      },
      onDurationChanged: (durationMs) => {
        ctx.state.audioPlaybackDurationMs = durationMs;
      },
      onPlaybackStarted: (event) => {
        ctx.state.audioPlaybackStartedTurnId = turnId;
        ctx.state.audioPlaybackStartedOrchestrationId = orchestrationId;
        ctx.state.audioPlaybackStartedMessageId = messageId;
        ctx.state.audioPlaybackStartedAtMs = event.startedAtMs;
        ctx.sessionStore?.markAudioStarted(
          orchestrationId,
          turnId,
          messageId,
          event.startedAtMs,
          ctx.state.audioPlaybackDurationMs,
        );
        console.info(
          "[Connection] audio playback started. turn_id=",
          turnId,
          "duration_ms=",
          ctx.state.audioPlaybackDurationMs,
        );
      },
      onEnded: () => {
        const completedTurnId = ctx.state.audioPlaybackStartedTurnId ?? turnId;
        const completedOrchestrationId =
          ctx.state.audioPlaybackStartedOrchestrationId ?? orchestrationId;
        const completedMessageId = ctx.state.audioPlaybackStartedMessageId ?? messageId;
        ctx.state.isPlayingAudio = false;
        ctx.state.audioPlaybackStartedTurnId = null;
        ctx.state.audioPlaybackStartedOrchestrationId = null;
        ctx.state.audioPlaybackStartedMessageId = null;
        ctx.state.audioPlaybackStartedAtMs = 0;
        ctx.state.audioPlaybackDurationMs = null;
        ctx.markTerminal(
          "completed",
          completedTurnId,
          completedOrchestrationId,
          "audio_playback_completed",
          completedMessageId,
        );
      },
      onError: () => {
        const failedTurnId = ctx.state.audioPlaybackStartedTurnId ?? turnId;
        const failedOrchestrationId =
          ctx.state.audioPlaybackStartedOrchestrationId ?? orchestrationId;
        const failedMessageId = ctx.state.audioPlaybackStartedMessageId ?? messageId;
        ctx.state.isPlayingAudio = false;
        ctx.state.audioPlaybackStartedTurnId = null;
        ctx.state.audioPlaybackStartedOrchestrationId = null;
        ctx.state.audioPlaybackStartedMessageId = null;
        ctx.state.audioPlaybackStartedAtMs = 0;
        ctx.state.audioPlaybackDurationMs = null;
        ctx.pushHistory("error", "音频播放失败。");
        ctx.markTerminal(
          "failed",
          failedTurnId,
          failedOrchestrationId,
          "audio_playback_error",
          failedMessageId,
        );
      },
    });
  } catch (error) {
    const failedOrchestrationId = orchestrationId;
    ctx.state.isPlayingAudio = false;
    ctx.state.audioPlaybackStartedTurnId = null;
    ctx.state.audioPlaybackStartedOrchestrationId = null;
    ctx.state.audioPlaybackStartedMessageId = null;
    ctx.state.audioPlaybackStartedAtMs = 0;
    ctx.state.audioPlaybackDurationMs = null;
    ctx.state.lastError =
      error instanceof Error ? error.message : "浏览器拒绝自动播放语音。";
    ctx.state.statusMessage = "语音播放失败，已回传结束状态。";
    ctx.pushHistory("error", ctx.state.statusMessage);
    ctx.markTerminal(
      "failed",
      turnId,
      failedOrchestrationId,
      "audio_autoplay_blocked",
      messageId,
    );
  }
}

export function stopAudioPlayback(ctx: AudioPlaybackContext): void {
  ctx.stopAudioRuntime();
  ctx.state.isPlayingAudio = false;
  ctx.state.audioPlaybackStartedTurnId = null;
  ctx.state.audioPlaybackStartedOrchestrationId = null;
  ctx.state.audioPlaybackStartedMessageId = null;
  ctx.state.audioPlaybackStartedAtMs = 0;
  ctx.state.audioPlaybackDurationMs = null;
}
