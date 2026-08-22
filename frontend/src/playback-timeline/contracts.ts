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
  | "audio_tail_continuation"
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
  /**
   * Whether this sink must be accepted before the shared timeline can start.
   * Defaults to `required`; sinks that are driven by the timeline clock can
   * remain open for completion without blocking the clock itself.
   */
  requiredForStart?: boolean;
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

/**
 * Live read access to one segment's authoritative Timeline clock.
 * Consumers must not substitute wall-clock time when this reader is present.
 */
export interface PlaybackTimelineClockReader {
  getSnapshot(): PlaybackTimelineSnapshot | null;
}
