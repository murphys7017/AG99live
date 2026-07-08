import type {
  AudioPlaybackClock,
  PlaybackTimelineSnapshot,
} from "./contracts.js";
import {
  createPlaybackTimelineEngine,
  type PlaybackTimelineEngine,
} from "./playbackTimelineEngine.js";
import type {
  PlaybackTimelineSegmentSinks,
  PlaybackTimelineSegmentExecutionResult,
  PlaybackTimelineSegmentJob,
} from "./segmentJob.js";
import type { NormalizedMotionPayload } from "../model-engine/contracts.js";

const AUDIO_TIMELINE_SINK_ID = "audio";
const LIP_SYNC_TIMELINE_SINK_ID = "lip_sync";
const MOTION_TIMELINE_SINK_ID = "motion";

type TimelineTerminal = "completed" | "failed" | "interrupted";

interface PlaybackTimelineEntry {
  turnId: string | null;
  messageId: string;
  engine: PlaybackTimelineEngine;
}

interface PlaybackTimelineSinkStartOptions {
  start?: () => boolean | void;
}

export interface PlaybackTimelineAudioSegment {
  turnId: string | null;
  messageId: string;
}

export interface PlaybackTimelineRuntimeDeps {
  getAudioClock: () => AudioPlaybackClock | null;
  onAudioTimelineStarted?: (
    turnId: string | null,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot | null,
  ) => void;
}

export interface PlaybackTimelineSegmentJobOptions {
  hasAudio: boolean;
  hasMotion: boolean;
  noAudioConfirmed: boolean;
}

export interface PlaybackTimelineRuntime {
  setSegmentSinks: (
    sinks: PlaybackTimelineSegmentSinks<NormalizedMotionPayload>,
  ) => void;
  startSegmentJob: (
    job: PlaybackTimelineSegmentJob<NormalizedMotionPayload>,
  ) => PlaybackTimelineSegmentExecutionResult;
  prepareSegmentJob: (
    turnId: string | null,
    messageId: string,
    options: PlaybackTimelineSegmentJobOptions,
  ) => boolean;
  prepareAudioTimeline: (
    turnId: string | null,
    messageId: string,
    options?: PlaybackTimelineSinkStartOptions,
  ) => void;
  prepareMotionOnlyTimeline: (
    turnId: string | null,
    messageId: string,
    options?: PlaybackTimelineSinkStartOptions,
  ) => PlaybackTimelineSnapshot | null;
  markAudioTimelineDuration: (
    turnId: string | null,
    messageId: string,
    durationMs: number | null,
  ) => void;
  markAudioTimelineStarted: (
    turnId: string | null,
    messageId: string,
    startedAtMs: number,
    durationMs: number | null,
  ) => void;
  markLipSyncTimelineStarted: (
    turnId: string | null,
    messageId: string,
  ) => void;
  markLipSyncTimelineTerminal: (
    turnId: string | null,
    messageId: string,
    terminal: TimelineTerminal,
    reason: string,
  ) => void;
  prepareMotionTimelineSink: (
    turnId: string | null,
    messageId: string,
    options?: PlaybackTimelineSinkStartOptions,
  ) => boolean;
  markMotionTimelineStarted: (
    turnId: string | null,
    messageId: string,
  ) => void;
  markMotionTimelineTerminal: (
    turnId: string | null,
    messageId: string,
    terminal: TimelineTerminal,
    reason: string,
  ) => void;
  markAudioTimelineTerminal: (
    turnId: string | null,
    messageId: string,
    terminal: TimelineTerminal,
    reason: string,
  ) => void;
  stopTimelineForSegment: (
    turnId: string | null,
    messageId: string,
    reason: string,
  ) => void;
  getTimelineSnapshotForSegment: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineSnapshot | null;
  findActiveAudioTimelineSegments: () => PlaybackTimelineAudioSegment[];
  findOpenAudioTimelineSegments: () => PlaybackTimelineAudioSegment[];
}

export function createPlaybackTimelineRuntime(
  deps: PlaybackTimelineRuntimeDeps,
): PlaybackTimelineRuntime {
  const timelines = new Map<string, PlaybackTimelineEntry>();
  let segmentSinks: PlaybackTimelineSegmentSinks<NormalizedMotionPayload> | null = null;

  function resolveTimelineKey(
    turnId: string | null,
    messageId: string,
  ): string {
    const normalizedTurnId = normalizeTurnId(turnId);
    const normalizedMessageId = messageId.trim();
    return `${normalizedTurnId.length}:${normalizedTurnId}:${normalizedMessageId}`;
  }

  function getTimeline(
    turnId: string | null,
    messageId: string,
  ): PlaybackTimelineEntry | null {
    return timelines.get(resolveTimelineKey(turnId, messageId)) ?? null;
  }

  function setTimeline(
    turnId: string | null,
    messageId: string,
    entry: PlaybackTimelineEntry,
  ): void {
    const key = resolveTimelineKey(turnId, messageId);
    timelines.set(key, entry);
  }

  function prepareAudioTimeline(
    turnId: string | null,
    messageId: string,
    options: PlaybackTimelineSinkStartOptions = {},
  ): void {
    const existing = getTimeline(turnId, messageId);
    if (existing?.engine.hasSink(AUDIO_TIMELINE_SINK_ID)) {
      existing.engine.registerSink({
        id: AUDIO_TIMELINE_SINK_ID,
        required: true,
        start: options.start,
      });
      if (!existing.engine.hasSink(LIP_SYNC_TIMELINE_SINK_ID)) {
        existing.engine.registerSink({
          id: LIP_SYNC_TIMELINE_SINK_ID,
          required: false,
        });
      }
      return;
    }
    const engine = createPlaybackTimelineEngine();
    engine.load(
      { turnId, messageId },
      [
        {
          id: AUDIO_TIMELINE_SINK_ID,
          required: true,
          start: options.start,
        },
        { id: LIP_SYNC_TIMELINE_SINK_ID, required: false },
      ],
    );
    setTimeline(turnId, messageId, {
      turnId,
      messageId,
      engine,
    });
  }

  function prepareSegmentJob(
    turnId: string | null,
    messageId: string,
    options: PlaybackTimelineSegmentJobOptions,
  ): boolean {
    if (options.hasAudio) {
      prepareAudioTimeline(turnId, messageId);
      if (options.hasMotion) {
        return prepareMotionTimelineSink(turnId, messageId);
      }
      return getTimeline(turnId, messageId) !== null;
    }

    if (options.hasMotion && options.noAudioConfirmed) {
      return prepareMotionOnlyTimeline(turnId, messageId) !== null;
    }

    return true;
  }

  function setSegmentSinks(
    sinks: PlaybackTimelineSegmentSinks<NormalizedMotionPayload>,
  ): void {
    segmentSinks = sinks;
  }

  function startSegmentJob(
    job: PlaybackTimelineSegmentJob<NormalizedMotionPayload>,
  ): PlaybackTimelineSegmentExecutionResult {
    if (!segmentSinks) {
      throw new Error("Playback timeline segment sinks are not configured.");
    }
    return startPreparedSegmentJob(job, segmentSinks);
  }

  function startPreparedSegmentJob(
    job: PlaybackTimelineSegmentJob<NormalizedMotionPayload>,
    sinks: PlaybackTimelineSegmentSinks<NormalizedMotionPayload>,
  ): PlaybackTimelineSegmentExecutionResult {
    let releasedText = false;
    if (job.text.release) {
      releasedText = sinks.textSink.releaseAssistantTextForPlayback(
        job.messageId,
        job.turnId,
      );
    }
    if (releasedText) {
      sinks.session.markTextReleased(job.turnId, job.messageId);
      sinks.session.markPhase(job.turnId, "playing");
    }

    let releasedAudio = false;
    if (job.audio.release) {
      prepareAudioTimeline(job.turnId, job.messageId, {
        start: () => sinks.audioSink.releaseAudioForPlayback(
          job.messageId,
          job.turnId,
        ),
      });
      releasedAudio = startTimelineSink(
        job.turnId,
        job.messageId,
        AUDIO_TIMELINE_SINK_ID,
      ) === true;
      if (!releasedAudio) {
        clearTimelineIfSinkIdle(
          job.turnId,
          job.messageId,
          AUDIO_TIMELINE_SINK_ID,
        );
      }
    }
    if (releasedAudio) {
      sinks.session.markAudioReleased(job.turnId, job.messageId);
      const prepared = prepareSegmentJob(
        job.turnId,
        job.messageId,
        {
          hasAudio: true,
          hasMotion: job.motion.payload !== null,
          noAudioConfirmed: false,
        },
      );
      if (!prepared) {
        throw new Error("Playback timeline segment preparation failed.");
      }
    }
    if (
      job.audio.release
      && !releasedAudio
      && job.motion.payload !== null
      && !job.audio.noAudioConfirmed
    ) {
      return {
        releasedText,
        releasedAudio,
        releasedMotion: false,
      };
    }

    let releasedMotion = false;
    if (job.motion.payload !== null) {
      const motionPayload = job.motion.payload;
      const receivedAtMs = job.motion.receivedAtMs;
      if (
        receivedAtMs === null
        || !Number.isFinite(receivedAtMs)
        || receivedAtMs < 0
      ) {
        throw new Error("Motion segment release requires a valid receivedAtMs.");
      }
      const timelineMode = job.audio.noAudioConfirmed && !job.audio.release
        ? "motion_only"
        : "audio";
      const startMotion = () => sinks.motionSink.start(
        motionPayload,
        {
          turnId: job.turnId,
          messageId: job.messageId,
          receivedAtMs,
          timelineMode,
        },
      );
      if (!releasedAudio && timelineMode === "motion_only") {
        const prepared = prepareMotionOnlyTimeline(
          job.turnId,
          job.messageId,
          { start: startMotion },
        ) !== null;
        if (!prepared) {
          sinks.session.markMotionFailed(
            job.turnId,
            job.messageId,
            "motion_only_timeline_unavailable",
          );
          return {
            releasedText,
            releasedAudio,
            releasedMotion: false,
          };
        }
      } else {
        const prepared = prepareMotionTimelineSink(
          job.turnId,
          job.messageId,
          { start: startMotion },
        );
        if (!prepared) {
          sinks.session.markMotionFailed(
            job.turnId,
            job.messageId,
            "motion_timeline_unavailable",
          );
          return {
            releasedText,
            releasedAudio,
            releasedMotion: false,
          };
        }
      }
      sinks.session.markMotionReleased(job.turnId, job.messageId);
      const accepted = startTimelineSink(
        job.turnId,
        job.messageId,
        MOTION_TIMELINE_SINK_ID,
      );
      releasedMotion = true;
      if (accepted === false) {
        sinks.session.markMotionFailed(
          job.turnId,
          job.messageId,
          "motion_payload_rejected",
        );
      }
      sinks.session.markPhase(job.turnId, "playing");
    }

    return {
      releasedText,
      releasedAudio,
      releasedMotion,
    };
  }

  function startTimelineSink(
    turnId: string | null,
    messageId: string,
    sinkId: string,
  ): boolean | void {
    const timeline = getTimeline(turnId, messageId);
    if (!timeline) {
      throw new Error(`Playback timeline missing before starting sink: ${sinkId}`);
    }
    return timeline.engine.startSink(sinkId);
  }

  function prepareMotionOnlyTimeline(
    turnId: string | null,
    messageId: string,
    options: PlaybackTimelineSinkStartOptions = {},
  ): PlaybackTimelineSnapshot | null {
    const existing = getTimeline(turnId, messageId);
    if (existing) {
      return prepareMotionTimelineSink(turnId, messageId, options)
        ? existing.engine.getSnapshot()
        : null;
    }
    const engine = createPlaybackTimelineEngine();
    engine.load(
      { turnId, messageId },
      [
        {
          id: MOTION_TIMELINE_SINK_ID,
          required: true,
          start: options.start,
        },
      ],
    );
    setTimeline(turnId, messageId, {
      turnId,
      messageId,
      engine,
    });
    return engine.getSnapshot();
  }

  function markAudioTimelineDuration(
    turnId: string | null,
    messageId: string,
    durationMs: number | null,
  ): void {
    const timeline = getTimelineWithSink(
      "audio.duration",
      AUDIO_TIMELINE_SINK_ID,
      turnId,
      messageId,
      {
        durationMs,
      },
    );
    if (!timeline) {
      return;
    }
    timeline.engine.setExpectedDurationMs(durationMs);
  }

  function markAudioTimelineStarted(
    turnId: string | null,
    messageId: string,
    startedAtMs: number,
    durationMs: number | null,
  ): void {
    const timeline = getTimelineWithSink(
      "audio.started",
      AUDIO_TIMELINE_SINK_ID,
      turnId,
      messageId,
      {
        startedAtMs,
        durationMs,
      },
    );
    if (!timeline) {
      return;
    }
    const engine = timeline.engine;
    engine.setExpectedDurationMs(durationMs);
    const audioClock = deps.getAudioClock();
    if (audioClock) {
      engine.attachAudioClock(audioClock);
    } else {
      engine.attachAudioClock(createUnavailableAudioClock());
    }
    engine.markSinkStarted(AUDIO_TIMELINE_SINK_ID);
    if (engine.getPhase() === "ready") {
      engine.start(startedAtMs);
    }
    deps.onAudioTimelineStarted?.(
      turnId,
      messageId,
      engine.getSnapshot(),
    );
  }

  function markLipSyncTimelineStarted(
    turnId: string | null,
    messageId: string,
  ): void {
    const timeline = getTimelineWithSink(
      "lip_sync.started",
      LIP_SYNC_TIMELINE_SINK_ID,
      turnId,
      messageId,
    );
    if (!timeline) {
      return;
    }
    timeline.engine.markSinkStarted(LIP_SYNC_TIMELINE_SINK_ID);
  }

  function markLipSyncTimelineTerminal(
    turnId: string | null,
    messageId: string,
    terminal: TimelineTerminal,
    reason: string,
  ): void {
    const timeline = getTimelineWithSink(
      "lip_sync.terminal",
      LIP_SYNC_TIMELINE_SINK_ID,
      turnId,
      messageId,
      {
        terminal,
        reason,
      },
    );
    if (!timeline) {
      return;
    }
    timeline.engine.markSinkTerminal(
      LIP_SYNC_TIMELINE_SINK_ID,
      terminal,
      reason,
    );
  }

  function prepareMotionTimelineSink(
    turnId: string | null,
    messageId: string,
    options: PlaybackTimelineSinkStartOptions = {},
  ): boolean {
    const timeline = getTimeline(turnId, messageId);
    if (!timeline) {
      return false;
    }
    const engine = timeline.engine;
    if (!engine.hasSink(MOTION_TIMELINE_SINK_ID)) {
      engine.registerSink({
        id: MOTION_TIMELINE_SINK_ID,
        required: true,
        start: options.start,
      });
    } else if (options.start) {
      engine.registerSink({
        id: MOTION_TIMELINE_SINK_ID,
        required: true,
        start: options.start,
      });
    }
    return true;
  }

  function markMotionTimelineStarted(
    turnId: string | null,
    messageId: string,
  ): void {
    const timeline = getTimelineWithSink(
      "motion.started",
      MOTION_TIMELINE_SINK_ID,
      turnId,
      messageId,
    );
    if (!timeline) {
      return;
    }
    const engine = timeline.engine;
    engine.markSinkStarted(MOTION_TIMELINE_SINK_ID);
    if (engine.getPhase() === "ready") {
      engine.start();
    }
  }

  function markMotionTimelineTerminal(
    turnId: string | null,
    messageId: string,
    terminal: TimelineTerminal,
    reason: string,
  ): void {
    const timeline = getTimelineWithSink(
      "motion.terminal",
      MOTION_TIMELINE_SINK_ID,
      turnId,
      messageId,
      {
        terminal,
        reason,
      },
    );
    if (!timeline) {
      return;
    }
    timeline.engine.markSinkTerminal(
      MOTION_TIMELINE_SINK_ID,
      terminal,
      reason,
    );
    clearTimelineIfTerminal(turnId, messageId);
  }

  function markAudioTimelineTerminal(
    turnId: string | null,
    messageId: string,
    terminal: TimelineTerminal,
    reason: string,
  ): void {
    const timeline = getTimelineWithSink(
      "audio.terminal",
      AUDIO_TIMELINE_SINK_ID,
      turnId,
      messageId,
      {
        terminal,
        reason,
      },
    );
    if (!timeline) {
      return;
    }
    const engine = timeline.engine;
    if (terminal === "interrupted") {
      engine.interrupt(reason);
    } else {
      engine.detachAudioClock();
      engine.markSinkTerminal(AUDIO_TIMELINE_SINK_ID, terminal, reason);
    }
    clearTimelineIfTerminal(turnId, messageId);
  }

  function stopTimelineForSegment(
    turnId: string | null,
    messageId: string,
    reason: string,
  ): void {
    const timeline = getTimeline(turnId, messageId);
    if (!timeline) {
      warnMissingTimeline("timeline.stop", turnId, messageId, {
        reason,
      });
      return;
    }
    timeline.engine.interrupt(reason);
    clearTimeline(turnId, messageId);
  }

  function getTimelineSnapshotForSegment(
    turnId: string | null,
    messageId: string,
  ): PlaybackTimelineSnapshot | null {
    return getTimeline(turnId, messageId)?.engine.getSnapshot() ?? null;
  }

  function findActiveAudioTimelineSegments(): PlaybackTimelineAudioSegment[] {
    return findAudioTimelineSegments((audioSink) => audioSink?.terminal === "started");
  }

  function findOpenAudioTimelineSegments(): PlaybackTimelineAudioSegment[] {
    return findAudioTimelineSegments((audioSink) =>
      audioSink?.terminal === "idle" || audioSink?.terminal === "started"
    );
  }

  function findAudioTimelineSegments(
    predicate: (
      audioSink: PlaybackTimelineSnapshot["sinks"][number] | undefined,
    ) => boolean,
  ): PlaybackTimelineAudioSegment[] {
    const segments: PlaybackTimelineAudioSegment[] = [];
    for (const timeline of timelines.values()) {
      const snapshot = timeline.engine.getSnapshot();
      if (!snapshot || isTimelineTerminalPhase(timeline)) {
        continue;
      }
      const audioSink = snapshot.sinks.find((sink) =>
        sink.id === AUDIO_TIMELINE_SINK_ID
      );
      if (predicate(audioSink)) {
        segments.push({
          turnId: timeline.turnId,
          messageId: timeline.messageId,
        });
      }
    }
    return segments;
  }

  function clearTimelineIfTerminal(
    turnId: string | null,
    messageId: string,
  ): void {
    const timeline = getTimeline(turnId, messageId);
    if (!timeline) {
      return;
    }
    if (isTimelineTerminalPhase(timeline)) {
      clearTimeline(turnId, messageId);
    }
  }

  function clearTimelineIfSinkIdle(
    turnId: string | null,
    messageId: string,
    sinkId: string,
  ): void {
    const timeline = getTimeline(turnId, messageId);
    if (!timeline) {
      return;
    }
    const sink = timeline.engine.getSnapshot()?.sinks.find((item) =>
      item.id === sinkId
    );
    if (sink?.terminal === "idle") {
      clearTimeline(turnId, messageId);
    }
  }

  function getTimelineWithSink(
    event: string,
    sinkId: string,
    turnId: string | null,
    messageId: string,
    details: Record<string, unknown> = {},
  ): PlaybackTimelineEntry | null {
    const timeline = getTimeline(turnId, messageId);
    if (!timeline) {
      warnMissingTimeline(event, turnId, messageId, details);
      return null;
    }
    if (!timeline.engine.hasSink(sinkId)) {
      warnMissingSink(event, sinkId, turnId, messageId, details);
      return null;
    }
    return timeline;
  }

  function clearTimeline(
    turnId: string | null,
    messageId: string,
  ): void {
    const key = resolveTimelineKey(turnId, messageId);
    timelines.delete(key);
  }

  function isTimelineTerminalPhase(timeline: PlaybackTimelineEntry): boolean {
    const phase = timeline.engine.getPhase();
    return phase === "completed" || phase === "failed" || phase === "interrupted";
  }

  return {
    setSegmentSinks,
    startSegmentJob,
    prepareSegmentJob,
    prepareAudioTimeline,
    prepareMotionOnlyTimeline,
    markAudioTimelineDuration,
    markAudioTimelineStarted,
    markLipSyncTimelineStarted,
    markLipSyncTimelineTerminal,
    prepareMotionTimelineSink,
    markMotionTimelineStarted,
    markMotionTimelineTerminal,
    markAudioTimelineTerminal,
    stopTimelineForSegment,
    getTimelineSnapshotForSegment,
    findActiveAudioTimelineSegments,
    findOpenAudioTimelineSegments,
  };
}

function createUnavailableAudioClock(): AudioPlaybackClock {
  return {
    getCurrentTimeMs: () => null,
    getDurationMs: () => null,
    getPlaybackRate: () => 1,
    isPlaying: () => true,
  };
}

function normalizeTurnId(value: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function warnMissingTimeline(
  event: string,
  turnId: string | null,
  messageId: string,
  details: Record<string, unknown> = {},
): void {
  console.warn(
    "[PlaybackTimelineRuntime] dropped timeline event for missing segment timeline.",
    {
      event,
      turnId,
      messageId,
      ...details,
    },
  );
}

function warnMissingSink(
  event: string,
  sinkId: string,
  turnId: string | null,
  messageId: string,
  details: Record<string, unknown> = {},
): void {
  console.warn(
    "[PlaybackTimelineRuntime] dropped timeline event for missing segment sink.",
    {
      event,
      sinkId,
      turnId,
      messageId,
      ...details,
    },
  );
}
