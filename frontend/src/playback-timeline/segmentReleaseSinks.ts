import {
  deletePendingPlaybackItem,
  getPendingPlaybackItem,
  matchesPlaybackGroup,
  type PendingAssistantTextItem,
  type PendingAudioItem,
} from "./playbackReleaseQueue.js";
import type {
  PlaybackTimelineSegmentAudioSink,
  PlaybackTimelineSegmentTextSink,
} from "./segmentJobExecutor.js";

export interface QueuedTextSegmentSinkState {
  pendingAssistantTexts: Map<string, PendingAssistantTextItem>;
  assistantTextDeliveryTurnId: string | null;
  statusMessage: string;
}

export interface QueuedTextSegmentSinkOptions {
  state: QueuedTextSegmentSinkState;
  updateAssistantText(text: string, turnId: string | null): void;
  markTextDelivered(
    turnId: string | null,
    messageId: string,
  ): void;
}

export interface QueuedAudioSegmentSinkState {
  pendingAudios: Map<string, PendingAudioItem>;
}

export interface QueuedAudioSegmentSinkOptions {
  state: QueuedAudioSegmentSinkState;
  startAudioPlayback(
    audioUrl: string,
    turnId: string | null,
    messageId: string,
  ): void;
}

export function createQueuedTextSegmentSink(
  options: QueuedTextSegmentSinkOptions,
): PlaybackTimelineSegmentTextSink {
  return {
    releaseAssistantTextForPlayback(messageId, turnId) {
      const item = getPendingPlaybackItem(
        options.state.pendingAssistantTexts,
        turnId,
        messageId,
      );
      if (!item) {
        return false;
      }
      const text = item.text.trim();
      if (!text) {
        return false;
      }
      if (!matchesPlaybackGroup(item.turnId, turnId)) {
        return false;
      }

      const releasedTurnId = item.turnId ?? turnId;
      deletePendingPlaybackItem(
        options.state.pendingAssistantTexts,
        turnId,
        messageId,
      );
      options.updateAssistantText(text, releasedTurnId);
      options.state.assistantTextDeliveryTurnId = releasedTurnId;
      options.markTextDelivered(releasedTurnId, messageId);
      options.state.statusMessage = "文本回复已进入同步播放。";
      return true;
    },
  };
}

export function createQueuedAudioSegmentSink(
  options: QueuedAudioSegmentSinkOptions,
): PlaybackTimelineSegmentAudioSink {
  return {
    releaseAudioForPlayback(messageId, turnId) {
      const item = getPendingPlaybackItem(
        options.state.pendingAudios,
        turnId,
        messageId,
      );
      if (!item) {
        return false;
      }
      const audioUrl = item.audioUrl.trim();
      if (!audioUrl) {
        return false;
      }
      if (!matchesPlaybackGroup(item.turnId, turnId)) {
        return false;
      }

      const releasedTurnId = item.turnId ?? turnId;
      deletePendingPlaybackItem(
        options.state.pendingAudios,
        turnId,
        messageId,
      );
      options.startAudioPlayback(audioUrl, releasedTurnId, messageId);
      return true;
    },
  };
}
