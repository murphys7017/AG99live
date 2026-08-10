import type {
  PlaybackTimelineAudioSegmentRunner,
} from "../../playback-timeline/audioSegmentTimelineRunner.js";

export interface AudioPlaybackState {
  isPlayingAudio: boolean;
  statusMessage: string;
  lastError: string;
}

function resolveAudioBridgeFailureReason(error: unknown): string {
  const name = error instanceof Error
    ? error.name
    : typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : "unknown";
  if (name === "NotAllowedError") {
    return "audio_autoplay_blocked";
  }
  if (name === "NotSupportedError") {
    return "audio_source_not_supported";
  }
  if (name === "AbortError") {
    return "audio_playback_aborted";
  }
  return "audio_playback_start_failed";
}

export interface AudioPlaybackStateBridgeContext {
  state: AudioPlaybackState;
  audioSegmentRunner: PlaybackTimelineAudioSegmentRunner;
  pushHistory: (role: string, text: string) => void;
}

export async function startAudioSegmentAndBridgeState(
  ctx: AudioPlaybackStateBridgeContext,
  audioUrl: string,
  turnId: string | null,
  messageId: string,
): Promise<void> {
  ctx.state.isPlayingAudio = false;
  ctx.state.statusMessage = "收到语音回复，正在准备播放。";
  ctx.pushHistory("system", ctx.state.statusMessage);

  try {
    await ctx.audioSegmentRunner.start(audioUrl, turnId, messageId, {
      onPlaybackStarted: (event) => {
        ctx.state.isPlayingAudio = true;
        ctx.state.statusMessage = "收到语音回复，正在播放。";
        console.info(
          "[Connection] audio playback started. turn_id=",
          turnId,
          "duration_ms=",
          event.durationMs,
        );
      },
      onEnded: () => {
        ctx.state.isPlayingAudio = false;
      },
      onError: (reason) => {
        ctx.state.isPlayingAudio = false;
        ctx.state.lastError = reason === "audio_autoplay_blocked"
          ? "浏览器拒绝自动播放语音。"
          : "音频播放失败。";
        ctx.state.statusMessage = "语音播放失败，已回传结束状态。";
        ctx.pushHistory("error", "音频播放失败。");
      },
    });
  } catch (error) {
    console.error("[Connection] audio playback start failed.", error);
    ctx.state.isPlayingAudio = false;
    const reason = resolveAudioBridgeFailureReason(error);
    ctx.state.lastError = reason === "audio_autoplay_blocked"
      ? "浏览器拒绝自动播放语音。"
      : "音频播放失败。";
    ctx.state.statusMessage = "语音播放失败，已回传结束状态。";
    ctx.pushHistory("error", ctx.state.lastError);
  }
}

export function stopAudioSegmentAndBridgeStateForSegment(
  ctx: AudioPlaybackStateBridgeContext,
  turnId: string | null,
  messageId: string | null,
  reason = "audio_playback_stopped",
): void {
  ctx.audioSegmentRunner.stop(
    turnId,
    messageId,
    reason,
  );
  if (!messageId && ctx.state.isPlayingAudio) {
    console.error(
      "[Connection] audio playback stopped without segment identity; timeline was not interrupted.",
      {
        turnId,
        messageId,
      },
    );
  }
  ctx.state.isPlayingAudio = false;
}
