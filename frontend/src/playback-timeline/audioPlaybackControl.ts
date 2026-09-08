export interface PlaybackTimelineAudioSegmentIdentity {
  turnId: string | null;
  messageId: string;
}

export interface PlaybackTimelineAudioControl {
  stopAudioAndSettleTurn(turnId: string | null, reason: string): void;
  stopAudioAndSettleAll(reason: string): void;
  findActiveAudioSegment(): PlaybackTimelineAudioSegmentIdentity | null;
  findOpenAudioSegment(): PlaybackTimelineAudioSegmentIdentity | null;
  findOpenExecutionSegment(): PlaybackTimelineAudioSegmentIdentity | null;
}
