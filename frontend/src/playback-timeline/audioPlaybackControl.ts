import type { PcmTimelineStream } from "./pcmTimelinePlayback.js";

export interface PlaybackTimelineAudioSegmentIdentity {
  turnId: string | null;
  messageId: string;
}

export interface PlaybackTimelineAudioControl {
  openPcmForTimelinePlayback(turnId: string, messageId: string): Promise<PcmTimelineStream>;
  stopAudioAndSettleTurn(turnId: string | null, reason: string): void;
  stopAudioAndSettleAll(reason: string): void;
  findActiveAudioSegment(): PlaybackTimelineAudioSegmentIdentity | null;
  findOpenAudioSegment(): PlaybackTimelineAudioSegmentIdentity | null;
  findOpenExecutionSegment(): PlaybackTimelineAudioSegmentIdentity | null;
}
