import type { PlaybackTimelineAudioSink } from "../../playback-timeline/audioSink.js";

export interface AudioPlaybackState {
  isPlayingAudio: boolean;
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackStartedMessageId: string | null;
  audioPlaybackStartedAtMs: number;
  audioPlaybackDurationMs: number | null;
  audioPlaybackTerminalState: "idle" | "completed" | "failed" | "absent";
  audioPlaybackTerminalReason: string;
  statusMessage: string;
  lastError: string;
}

export interface AudioPlaybackSessionStore {
  markAudioStarted: (
    turnId: string | null,
    messageId: string,
    startedAtMs?: number | null,
    durationMs?: number | null,
  ) => void;
  markAudioDuration: (
    turnId: string | null,
    messageId: string,
    durationMs: number | null,
  ) => void;
}

export interface AudioPlaybackContext {
  state: AudioPlaybackState;
  audioSink: PlaybackTimelineAudioSink;
  prepareAudioTimeline: (turnId: string | null, messageId: string) => void;
  markAudioTimelineDuration: (
    turnId: string | null,
    messageId: string,
    durationMs: number | null,
  ) => void;
  markAudioTimelineStarted: (
    turnId: string | null,
    messageId: string,
    startedAtMs: number,
    durationMs: number | null,
  ) => void;
  markLipSyncTimelineStarted: (
    turnId: string | null,
    messageId: string,
  ) => void;
  markLipSyncTimelineTerminal: (
    turnId: string | null,
    messageId: string,
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ) => void;
  markAudioTimelineTerminal: (
    turnId: string | null,
    messageId: string,
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ) => void;
  stopActiveAudioTimeline: (reason: string) => void;
  pushHistory: (role: string, text: string) => void;
  markTerminal: (
    terminalState: "completed" | "failed" | "absent",
    turnId: string | null,
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
  messageId: string,
): Promise<void> {
  stopAudioPlayback(ctx);
  ctx.resetTerminal();
  ctx.prepareAudioTimeline(turnId, messageId);
  ctx.state.isPlayingAudio = true;
  ctx.state.audioPlaybackStartedTurnId = turnId;
  ctx.state.audioPlaybackStartedMessageId = messageId;
  ctx.state.audioPlaybackStartedAtMs = 0;
  ctx.state.audioPlaybackDurationMs = null;
  ctx.state.statusMessage = "收到语音回复，正在播放。";
  ctx.pushHistory("system", ctx.state.statusMessage);

  try {
    await ctx.audioSink.start(audioUrl, {
      onLipSyncUnavailable: () => {
        ctx.pushHistory("system", "嘴型同步加载失败，音频播放将无对应张嘴动作。");
      },
      onLipSyncStarted: () => {
        ctx.markLipSyncTimelineStarted(
          turnId,
          messageId,
        );
      },
      onLipSyncTerminal: (terminal, reason) => {
        ctx.markLipSyncTimelineTerminal(
          turnId,
          messageId,
          terminal,
          reason,
        );
      },
      onDurationChanged: (durationMs) => {
        ctx.state.audioPlaybackDurationMs = durationMs;
        ctx.markAudioTimelineDuration(
          turnId,
          messageId,
          durationMs,
        );
        ctx.sessionStore?.markAudioDuration(
          turnId,
          messageId,
          durationMs,
        );
      },
      onPlaybackStarted: (event) => {
        ctx.state.audioPlaybackStartedTurnId = turnId;
        ctx.state.audioPlaybackStartedMessageId = messageId;
        ctx.state.audioPlaybackStartedAtMs = event.startedAtMs;
        ctx.markAudioTimelineStarted(
          turnId,
          messageId,
          event.startedAtMs,
          ctx.state.audioPlaybackDurationMs,
        );
        ctx.sessionStore?.markAudioStarted(
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
        const completedMessageId = ctx.state.audioPlaybackStartedMessageId ?? messageId;
        ctx.state.isPlayingAudio = false;
        ctx.state.audioPlaybackStartedTurnId = null;
        ctx.state.audioPlaybackStartedMessageId = null;
        ctx.state.audioPlaybackStartedAtMs = 0;
        ctx.state.audioPlaybackDurationMs = null;
        ctx.markTerminal(
          "completed",
          completedTurnId,
          "audio_playback_completed",
          completedMessageId,
        );
        ctx.markAudioTimelineTerminal(
          completedTurnId,
          completedMessageId,
          "completed",
          "audio_playback_completed",
        );
      },
      onError: () => {
        const failedTurnId = ctx.state.audioPlaybackStartedTurnId ?? turnId;
        const failedMessageId = ctx.state.audioPlaybackStartedMessageId ?? messageId;
        ctx.state.isPlayingAudio = false;
        ctx.state.audioPlaybackStartedTurnId = null;
        ctx.state.audioPlaybackStartedMessageId = null;
        ctx.state.audioPlaybackStartedAtMs = 0;
        ctx.state.audioPlaybackDurationMs = null;
        ctx.pushHistory("error", "音频播放失败。");
        ctx.markTerminal(
          "failed",
          failedTurnId,
          "audio_playback_error",
          failedMessageId,
        );
        ctx.markAudioTimelineTerminal(
          failedTurnId,
          failedMessageId,
          "failed",
          "audio_playback_error",
        );
      },
    });
  } catch (error) {
    ctx.state.isPlayingAudio = false;
    ctx.state.audioPlaybackStartedTurnId = null;
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
      "audio_autoplay_blocked",
      messageId,
    );
    ctx.markAudioTimelineTerminal(
      turnId,
      messageId,
      "failed",
      "audio_autoplay_blocked",
    );
  }
}

export function stopAudioPlayback(ctx: AudioPlaybackContext): void {
  const interruptedTurnId = ctx.state.audioPlaybackStartedTurnId;
  const interruptedMessageId = ctx.state.audioPlaybackStartedMessageId;
  const shouldMarkInterruptedTerminal =
    ctx.state.audioPlaybackTerminalState === "idle";
  ctx.audioSink.stop();
  if (interruptedMessageId && shouldMarkInterruptedTerminal) {
    ctx.markTerminal(
      "failed",
      interruptedTurnId,
      "audio_playback_stopped",
      interruptedMessageId,
    );
    ctx.markAudioTimelineTerminal(
      interruptedTurnId,
      interruptedMessageId,
      "interrupted",
      "audio_playback_stopped",
    );
  } else if (interruptedMessageId) {
    ctx.markAudioTimelineTerminal(
      interruptedTurnId,
      interruptedMessageId,
      "interrupted",
      ctx.state.audioPlaybackTerminalReason || "audio_playback_stopped",
    );
  } else {
    ctx.stopActiveAudioTimeline("audio_playback_stopped");
  }
  ctx.state.isPlayingAudio = false;
  ctx.state.audioPlaybackStartedTurnId = null;
  ctx.state.audioPlaybackStartedMessageId = null;
  ctx.state.audioPlaybackStartedAtMs = 0;
  ctx.state.audioPlaybackDurationMs = null;
}
