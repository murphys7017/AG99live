export type TimelinePhase =
  | "idle"
  | "preparing"
  | "ready"
  | "playing"
  | "paused"
  | "stopping"
  | "completed"
  | "failed"
  | "interrupted";

export type TimelineClockSource =
  | "audio"
  | "audio_pending"
  | "synthetic"
  | "audio_unavailable";

export type SinkTerminal =
  | "idle"
  | "started"
  | "completed"
  | "failed"
  | "absent"
  | "interrupted";

export interface SegmentPlaybackJob {
  turnId: string | null;
  messageId: string;
}

export interface AudioPlaybackClock {
  getCurrentTimeMs(): number | null;
  getDurationMs(): number | null;
  getPlaybackRate(): number;
  isPlaying(): boolean;
}

export interface PlaybackClockSnapshot {
  startedAtMs: number | null;
  currentTimeMs: number;
  durationMs: number | null;
  playbackRate: number;
  clockSource: TimelineClockSource;
  paused: boolean;
  stopped: boolean;
}

export interface PlaybackTimelineSinkDefinition {
  id: string;
  required: boolean;
  initialTerminal?: Exclude<SinkTerminal, "started">;
  start?: () => boolean | void;
  onInterrupt?: (reason: string) => void;
}

export interface PlaybackTimelineSinkState {
  id: string;
  required: boolean;
  terminal: SinkTerminal;
  reason?: string;
}

export interface PlaybackTimelineSnapshot {
  timelineId: string;
  turnId: string | null;
  messageId: string;
  phase: TimelinePhase;
  clockSource: TimelineClockSource;
  startedAtMs: number | null;
  currentTimeMs: number;
  durationMs: number | null;
  playbackRate: number;
  sinks: PlaybackTimelineSinkState[];
}
