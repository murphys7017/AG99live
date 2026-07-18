import type { Ref } from "vue";
import type { NormalizedMotionPayload } from "../playback-integrations/motionPayload.js";
import type { ModelSummary } from "../types/protocol.js";
import type { PlaybackTimelineMotionContext } from "../playback-timeline/motionTypes.js";

export interface MotionPayloadPort {
  start(
    payload: NormalizedMotionPayload,
    context: PlaybackTimelineMotionContext,
  ): boolean | void;
}

export interface PlaybackAckPort {
  sendPlaybackFinishedForCurrentGroup(
    turnId: string | null,
    success: boolean,
    reason?: string,
  ): Promise<boolean>;
  clearPlaybackGroupContext(
    turnId: string | null,
  ): void;
}

export interface MotionPlaybackRecordPort {
  getLastAssistantText(): string;
  getSelectedModel(): Ref<ModelSummary | null>;
}
