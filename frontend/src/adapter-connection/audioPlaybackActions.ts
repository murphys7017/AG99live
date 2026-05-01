import type { StartAudioPlaybackOptions } from "./audioPlayback";

export interface AudioPlaybackState {
  isPlayingAudio: boolean;
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackStartedOrchestrationId: string | null;
  audioPlaybackStartedAtMs: number;
  audioPlaybackDurationMs: number | null;
  audioPlaybackStartedNonce: number;
  statusMessage: string;
  currentOrchestrationId: string | null;
  lastError: string;
}

export interface AudioPlaybackContext {
  state: AudioPlaybackState;
  startAudio: (url: string, opts: StartAudioPlaybackOptions) => Promise<void>;
  stopAudioRuntime: () => void;
  pushHistory: (role: string, text: string) => void;
  markTerminal: (
    terminalState: "completed" | "failed" | "not_requested",
    turnId: string | null,
    orchestrationId: string | null,
    reason?: string,
  ) => void;
  resetTerminal: () => void;
}

export async function playAudioAndAcknowledge(
  ctx: AudioPlaybackContext,
  audioUrl: string,
  turnId: string | null,
): Promise<void> {
  stopAudioPlayback(ctx);
  ctx.resetTerminal();
  ctx.state.isPlayingAudio = true;
  ctx.state.audioPlaybackStartedTurnId = null;
  ctx.state.audioPlaybackStartedOrchestrationId = null;
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
        ctx.state.audioPlaybackStartedOrchestrationId = ctx.state.currentOrchestrationId;
        ctx.state.audioPlaybackStartedAtMs = event.startedAtMs;
        ctx.state.audioPlaybackStartedNonce += 1;
        console.info(
          "[Connection] audio playback started. turn_id=",
          turnId,
          "duration_ms=",
          ctx.state.audioPlaybackDurationMs,
          "nonce=",
          ctx.state.audioPlaybackStartedNonce,
        );
      },
      onEnded: () => {
        const completedTurnId = ctx.state.audioPlaybackStartedTurnId ?? turnId;
        const completedOrchestrationId =
          ctx.state.audioPlaybackStartedOrchestrationId ?? ctx.state.currentOrchestrationId;
        ctx.state.isPlayingAudio = false;
        ctx.state.audioPlaybackStartedTurnId = null;
        ctx.state.audioPlaybackStartedOrchestrationId = null;
        ctx.state.audioPlaybackStartedAtMs = 0;
        ctx.state.audioPlaybackDurationMs = null;
        ctx.markTerminal(
          "completed",
          completedTurnId,
          completedOrchestrationId,
          "audio_playback_completed",
        );
      },
      onError: () => {
        const failedTurnId = ctx.state.audioPlaybackStartedTurnId ?? turnId;
        const failedOrchestrationId =
          ctx.state.audioPlaybackStartedOrchestrationId ?? ctx.state.currentOrchestrationId;
        ctx.state.isPlayingAudio = false;
        ctx.state.audioPlaybackStartedTurnId = null;
        ctx.state.audioPlaybackStartedOrchestrationId = null;
        ctx.state.audioPlaybackStartedAtMs = 0;
        ctx.state.audioPlaybackDurationMs = null;
        ctx.pushHistory("error", "音频播放失败。");
        ctx.markTerminal(
          "failed",
          failedTurnId,
          failedOrchestrationId,
          "audio_playback_error",
        );
      },
    });
  } catch (error) {
    const failedOrchestrationId = ctx.state.currentOrchestrationId;
    ctx.state.isPlayingAudio = false;
    ctx.state.audioPlaybackStartedTurnId = null;
    ctx.state.audioPlaybackStartedOrchestrationId = null;
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
    );
  }
}

export function stopAudioPlayback(ctx: AudioPlaybackContext): void {
  ctx.stopAudioRuntime();
  ctx.state.isPlayingAudio = false;
  ctx.state.audioPlaybackStartedTurnId = null;
  ctx.state.audioPlaybackStartedOrchestrationId = null;
  ctx.state.audioPlaybackStartedAtMs = 0;
  ctx.state.audioPlaybackDurationMs = null;
}
