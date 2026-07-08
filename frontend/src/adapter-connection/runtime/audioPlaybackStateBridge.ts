import type {
  PlaybackTimelineAudioSegmentRunner,
} from "../../playback-timeline/audioSegmentTimelineRunner.js";

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
  markAudioReleased: (
    turnId: string | null,
    messageId: string,
  ) => void;
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

export interface AudioPlaybackStateBridgeContext {
  state: AudioPlaybackState;
  audioSegmentRunner: PlaybackTimelineAudioSegmentRunner;
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

export async function startAudioSegmentAndBridgeState(
  ctx: AudioPlaybackStateBridgeContext,
  audioUrl: string,
  turnId: string | null,
  messageId: string,
): Promise<void> {
  stopAudioSegmentAndBridgeState(ctx);
  ctx.resetTerminal();
  ctx.sessionStore?.markAudioReleased(turnId, messageId);
  ctx.state.isPlayingAudio = true;
  ctx.state.audioPlaybackStartedTurnId = turnId;
  ctx.state.audioPlaybackStartedMessageId = messageId;
  ctx.state.audioPlaybackStartedAtMs = 0;
  ctx.state.audioPlaybackDurationMs = null;
  ctx.state.statusMessage = "收到语音回复，正在播放。";
  ctx.pushHistory("system", ctx.state.statusMessage);

  try {
    await ctx.audioSegmentRunner.start(audioUrl, turnId, messageId, {
      onDurationChanged: (durationMs) => {
        ctx.state.audioPlaybackDurationMs = durationMs;
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
      },
      onError: (reason) => {
        const failedTurnId = ctx.state.audioPlaybackStartedTurnId ?? turnId;
        const failedMessageId = ctx.state.audioPlaybackStartedMessageId ?? messageId;
        ctx.state.isPlayingAudio = false;
        ctx.state.audioPlaybackStartedTurnId = null;
        ctx.state.audioPlaybackStartedMessageId = null;
        ctx.state.audioPlaybackStartedAtMs = 0;
        ctx.state.audioPlaybackDurationMs = null;
        ctx.state.lastError = reason === "audio_autoplay_blocked"
          ? "浏览器拒绝自动播放语音。"
          : "音频播放失败。";
        ctx.state.statusMessage = "语音播放失败，已回传结束状态。";
        ctx.pushHistory("error", "音频播放失败。");
        ctx.markTerminal(
          "failed",
          failedTurnId,
          reason,
          failedMessageId,
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
  }
}

export function stopAudioSegmentAndBridgeState(
  ctx: AudioPlaybackStateBridgeContext,
): void {
  stopAudioSegmentAndBridgeStateForSegment(
    ctx,
    ctx.state.audioPlaybackStartedTurnId,
    ctx.state.audioPlaybackStartedMessageId,
  );
}

export function stopAudioSegmentAndBridgeStateForSegment(
  ctx: AudioPlaybackStateBridgeContext,
  turnId: string | null,
  messageId: string | null,
): void {
  const interruptedTurnId = turnId;
  const interruptedMessageId = messageId;
  const wasPlayingAudio = ctx.state.isPlayingAudio;
  const shouldMarkInterruptedTerminal =
    ctx.state.audioPlaybackTerminalState === "idle";
  ctx.audioSegmentRunner.stop(
    interruptedTurnId,
    interruptedMessageId,
    ctx.state.audioPlaybackTerminalReason || "audio_playback_stopped",
  );
  if (interruptedMessageId && shouldMarkInterruptedTerminal) {
    ctx.markTerminal(
      "failed",
      interruptedTurnId,
      "audio_playback_stopped",
      interruptedMessageId,
    );
  } else if (!interruptedMessageId && wasPlayingAudio) {
    console.error(
      "[Connection] audio playback stopped without segment identity; timeline was not interrupted.",
      {
        turnId: interruptedTurnId,
        messageId: interruptedMessageId,
      },
    );
  }
  ctx.state.isPlayingAudio = false;
  ctx.state.audioPlaybackStartedTurnId = null;
  ctx.state.audioPlaybackStartedMessageId = null;
  ctx.state.audioPlaybackStartedAtMs = 0;
  ctx.state.audioPlaybackDurationMs = null;
}
