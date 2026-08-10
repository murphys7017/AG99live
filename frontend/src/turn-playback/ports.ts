import type { Ref } from "vue";
import type { ModelSummary } from "../types/protocol.js";

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
  getSelectedModel(): Ref<ModelSummary | null>;
}
