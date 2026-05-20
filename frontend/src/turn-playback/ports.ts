import type { Ref } from "vue";
import type { ModelEnginePlanStartedEvent } from "../model-engine/runtime/contracts.js";
import type {
  NormalizedMotionPayload,
} from "../model-engine/contracts.js";
import type { ModelSummary } from "../types/protocol.js";
import type { TurnPlaybackReleaseContext } from "./turnPlaybackOrchestratorCore.js";

export interface PlaybackReleasePort {
  releaseAssistantTextForPlayback(
    messageId: string,
    turnId: string | null,
  ): boolean;
  releaseAudioForPlayback(
    messageId: string,
    turnId: string | null,
  ): boolean;
}

export interface MotionPayloadPort {
  ingestNormalizedPayload(
    payload: NormalizedMotionPayload,
    context: TurnPlaybackReleaseContext,
  ): void;
  notifyCurrentTurnChanged(turnId: string | null): void;
}

export interface PlaybackAckPort {
  sendPlaybackFinishedForCurrentGroup(
    turnId: string | null,
    success: boolean,
    reason?: string,
  ): Promise<void>;
  clearPlaybackGroupContext(
    turnId: string | null,
  ): void;
}

export interface MotionPlaybackRecordPort {
  getLastAssistantText(): string;
  getSelectedModel(): Ref<ModelSummary | null>;
}

export type MotionPlaybackRecorder = (
  event: ModelEnginePlanStartedEvent,
) => void;
