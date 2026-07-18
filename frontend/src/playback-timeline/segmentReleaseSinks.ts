import type {
  PlaybackTimelineSegmentTextSink,
} from "./segmentJob.js";

export interface TextSegmentSinkState {
  assistantTextDeliveryTurnId: string | null;
  statusMessage: string;
}

export interface TextSegmentSinkOptions {
  state: TextSegmentSinkState;
  updateAssistantText(text: string, turnId: string | null): void;
  markTextDelivered(
    turnId: string | null,
    messageId: string,
  ): void;
  markTextFailed(
    turnId: string | null,
    messageId: string,
    reason: string,
  ): void;
}

export function createTextSegmentSink(
  options: TextSegmentSinkOptions,
): PlaybackTimelineSegmentTextSink {
  return {
    releaseAssistantTextForPlayback(textValue, messageId, turnId) {
      const text = textValue.trim();
      if (!text) {
        return false;
      }
      options.updateAssistantText(text, turnId);
      options.state.assistantTextDeliveryTurnId = turnId;
      options.markTextDelivered(turnId, messageId);
      options.state.statusMessage = "文本回复已进入同步播放。";
      return true;
    },
    failAssistantTextForPlayback(messageId, turnId, reason) {
      options.markTextFailed(turnId, messageId, reason);
      options.state.statusMessage = "字幕未能随音频开始播放。";
      return true;
    },
  };
}
