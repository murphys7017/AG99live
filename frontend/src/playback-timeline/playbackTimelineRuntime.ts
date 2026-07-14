import type {
  AudioPlaybackClock,
  PlaybackTimelineSnapshot,
} from "./contracts.js";
import {
  createPlaybackTimelineEngine,
  type PlaybackTimelineEngine,
} from "./playbackTimelineEngine.js";
import type {
  PlaybackTimelineSegmentExecutionPorts,
  PlaybackTimelineSegmentExecutionResult,
  PlaybackTimelineSegmentJob,
} from "./segmentJob.js";
import {
  executePlaybackTimelineSegmentJob,
  type PlaybackTimelineDeferredTextRelease,
  type PlaybackTimelineSegmentExecutorTimelinePort,
} from "./segmentJobExecutor.js";

const AUDIO_TIMELINE_SINK_ID = "audio";
const LIP_SYNC_TIMELINE_SINK_ID = "lip_sync";
const MAX_CLOSED_TIMELINE_KEYS = 512;
const MOTION_TIMELINE_SINK_ID = "motion";

type TimelineTerminal = "completed" | "failed" | "interrupted";

interface PlaybackTimelineEntry {
  turnId: string | null;
  messageId: string;
  engine: PlaybackTimelineEngine;
  deferredText: PlaybackTimelineDeferredTextRelease | null;
}

interface PlaybackTimelineSinkStartOptions {
  start?: () => boolean | void;
  onInterrupt?: (reason: string) => void;
  deferredText?: PlaybackTimelineDeferredTextRelease;
}

export interface PlaybackTimelineAudioSegment {
  turnId: string | null;
  messageId: string;
}

export interface PlaybackTimelineRuntimeDeps<TMotionPayload = unknown> {
  getAudioClock: () => AudioPlaybackClock | null;
  segmentExecution: PlaybackTimelineSegmentExecutionPorts<TMotionPayload>;
  audioSession?: PlaybackTimelineAudioSessionPort;
  motionSession?: PlaybackTimelineMotionSessionPort;
  onAudioTimelineStarted?: (
    turnId: string | null,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot | null,
  ) => void;
  onAudioTimelineDurationReady?: (
    turnId: string | null,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot,
  ) => void;
}

export interface PlaybackTimelineAudioSessionPort {
  markAudioStarted: (
    turnId: string | null,
    messageId: string,
    startedAtMs?: number | null,
    durationMs?: number | null,
  ) => void;
  markAudioDuration: (
    turnId: string | null,
    messageId: string,
    durationMs: number | null,
  ) => void;
  markAudioTerminal: (
    turnId: string | null,
    terminal: "completed" | "failed" | "absent",
    messageId: string,
    reason?: string,
  ) => void;
}

export interface PlaybackTimelineMotionSessionPort {
  markMotionStarted: (
    turnId: string | null,
    messageId: string,
  ) => void;
  markMotionCompleted: (
    turnId: string | null,
    messageId: string,
  ) => void;
  markMotionFailed: (
    turnId: string | null,
    messageId: string,
    reason?: string,
  ) => void;
}

export interface PlaybackTimelineRuntime<TMotionPayload = unknown> {
  startSegmentJob: (
    job: PlaybackTimelineSegmentJob<TMotionPayload>,
  ) => PlaybackTimelineSegmentExecutionResult;
  startAudioTimelineSink: (
    turnId: string | null,
    messageId: string,
    options: PlaybackTimelineSinkStartOptions,
  ) => boolean | void;
  startLipSyncTimelineSink: (
    turnId: string | null,
    messageId: string,
    start: () => boolean | void,
  ) => boolean | void;
  ensureMotionTimelineSinkForSegment: (
    turnId: string | null,
    messageId: string,
    onInterrupt?: (reason: string) => void,
  ) => boolean;
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
  ) => boolean;
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
  stopTimelinesForTurn: (turnId: string | null, reason: string) => void;
  stopAllTimelines: (reason: string) => void;
  getTimelineSnapshotForSegment: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineSnapshot | null;
  findActiveAudioTimelineSegments: () => PlaybackTimelineAudioSegment[];
  findOpenAudioTimelineSegments: () => PlaybackTimelineAudioSegment[];
}

export function createPlaybackTimelineRuntime<TMotionPayload = unknown>(
  deps: PlaybackTimelineRuntimeDeps<TMotionPayload>,
): PlaybackTimelineRuntime<TMotionPayload> {
  const timelines = new Map<string, PlaybackTimelineEntry>();
  const closedTimelineKeys = new Set<string>();

  function resolveTimelineKey(
    turnId: string | null,
    messageId: string,
  ): string {
    const normalizedTurnId = normalizeTurnId(turnId);
    const normalizedMessageId = messageId.trim();
    if (!normalizedTurnId) {
      throw new Error("Playback timeline requires a non-empty turnId.");
    }
    if (!normalizedMessageId) {
      throw new Error("Playback timeline requires a non-empty messageId.");
    }
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
    closedTimelineKeys.delete(key);
    timelines.set(key, entry);
  }

  function prepareAudioTimeline(
    turnId: string | null,
    messageId: string,
    options: PlaybackTimelineSinkStartOptions = {},
  ): void {
    const existing = getTimeline(turnId, messageId);
    if (existing?.engine.hasSink(AUDIO_TIMELINE_SINK_ID)) {
      if (options.deferredText) {
        if (existing.deferredText) {
          throw new Error("Playback timeline subtitle release already registered.");
        }
        existing.deferredText = options.deferredText;
      }
      existing.engine.registerSink({
        id: AUDIO_TIMELINE_SINK_ID,
        required: true,
        start: options.start,
        onInterrupt: options.onInterrupt,
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
          onInterrupt: options.onInterrupt,
        },
        { id: LIP_SYNC_TIMELINE_SINK_ID, required: false },
      ],
    );
    setTimeline(turnId, messageId, {
      turnId,
      messageId,
      engine,
      deferredText: options.deferredText ?? null,
    });
  }

  function ensureAudioSegmentTimeline(
    turnId: string | null,
    messageId: string,
    options: {
      hasMotion: boolean;
    },
  ): boolean {
    prepareAudioTimeline(turnId, messageId);
    if (options.hasMotion) {
      return ensureMotionTimelineSink(turnId, messageId);
    }
    return getTimeline(turnId, messageId) !== null;
  }

  function startAudioTimelineSink(
    turnId: string | null,
    messageId: string,
    options: PlaybackTimelineSinkStartOptions,
  ): boolean | void {
    prepareAudioTimeline(turnId, messageId, options);
    return startTimelineSink(
      turnId,
      messageId,
      AUDIO_TIMELINE_SINK_ID,
    );
  }

  function startLipSyncTimelineSink(
    turnId: string | null,
    messageId: string,
    start: () => boolean | void,
  ): boolean | void {
    const timeline = getTimeline(turnId, messageId);
    if (!timeline) {
      throw new Error("Playback timeline missing before starting sink: lip_sync");
    }
    timeline.engine.registerSink({
      id: LIP_SYNC_TIMELINE_SINK_ID,
      required: false,
      start,
    });
    return startTimelineSink(turnId, messageId, LIP_SYNC_TIMELINE_SINK_ID);
  }

  function startSegmentJob(
    job: PlaybackTimelineSegmentJob<TMotionPayload>,
  ): PlaybackTimelineSegmentExecutionResult {
    return executePlaybackTimelineSegmentJob({
      job,
      ports: deps.segmentExecution,
      timeline: segmentExecutorTimelinePort,
    });
  }

  const segmentExecutorTimelinePort: PlaybackTimelineSegmentExecutorTimelinePort = {
    startAudioSink(turnId, messageId, start, deferredText) {
      return startAudioTimelineSink(turnId, messageId, { start, deferredText });
    },
    ensureAudioSegmentTimeline,
    clearAudioSinkIfIdle(turnId, messageId) {
      clearTimelineIfSinkIdle(
        turnId,
        messageId,
        AUDIO_TIMELINE_SINK_ID,
      );
    },
    ensureMotionOnlyTimeline(turnId, messageId, start, interrupt) {
      return ensureMotionOnlyTimeline(
        turnId,
        messageId,
        { start, onInterrupt: interrupt },
      ) !== null;
    },
    ensureMotionTimelineSink(turnId, messageId, start, interrupt) {
      return ensureMotionTimelineSink(
        turnId,
        messageId,
        { start, onInterrupt: interrupt },
      );
    },
    startMotionSink(turnId, messageId) {
      return startTimelineSink(
        turnId,
        messageId,
        MOTION_TIMELINE_SINK_ID,
      );
    },
  };

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

  function ensureMotionOnlyTimeline(
    turnId: string | null,
    messageId: string,
    options: PlaybackTimelineSinkStartOptions = {},
  ): PlaybackTimelineSnapshot | null {
    const existing = getTimeline(turnId, messageId);
    if (existing) {
      return ensureMotionTimelineSink(turnId, messageId, options)
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
          onInterrupt: options.onInterrupt,
        },
      ],
    );
    setTimeline(turnId, messageId, {
      turnId,
      messageId,
      engine,
      deferredText: null,
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
    deps.audioSession?.markAudioDuration(
      turnId,
      messageId,
      durationMs,
    );
    if (
      typeof durationMs === "number"
      && Number.isFinite(durationMs)
      && durationMs > 0
    ) {
      const snapshot = timeline.engine.getSnapshot();
      if (!snapshot) {
        throw new Error("Playback timeline snapshot missing after audio duration update.");
      }
      deps.onAudioTimelineDurationReady?.(turnId, messageId, snapshot);
    }
  }

  function markAudioTimelineStarted(
    turnId: string | null,
    messageId: string,
    startedAtMs: number,
    durationMs: number | null,
  ): boolean {
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
      return false;
    }
    const engine = timeline.engine;
    engine.setExpectedDurationMs(durationMs);
    const audioClock = deps.getAudioClock();
    if (!audioClock) {
      failDeferredText(
        timeline,
        "subtitle_audio_clock_unavailable_on_started",
      );
      failTimelineSegment(timeline, "audio_clock_unavailable_on_started");
      return false;
    }
    engine.attachAudioClock(audioClock);
    engine.markSinkStarted(AUDIO_TIMELINE_SINK_ID);
    if (engine.getPhase() === "ready") {
      engine.start(startedAtMs);
    }
    deps.audioSession?.markAudioStarted(
      turnId,
      messageId,
      startedAtMs,
      durationMs,
    );
    if (!releaseDeferredText(timeline)) {
      failTimelineSegment(timeline, "subtitle_release_queue_invariant_failed");
      deps.segmentExecution.session.markSessionFailed(
        turnId,
        `subtitle_release_queue_invariant_failed:${messageId}`,
      );
      return false;
    }
    deps.onAudioTimelineStarted?.(
      turnId,
      messageId,
      engine.getSnapshot(),
    );
    return true;
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

  function ensureMotionTimelineSink(
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
        onInterrupt: options.onInterrupt,
      });
    } else if (options.start) {
      engine.registerSink({
        id: MOTION_TIMELINE_SINK_ID,
        required: true,
        start: options.start,
        onInterrupt: options.onInterrupt,
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
    if (hasOpenSink(timeline, MOTION_TIMELINE_SINK_ID)) {
      deps.motionSession?.markMotionStarted(turnId, messageId);
    }
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
    if (hasOpenSink(timeline, MOTION_TIMELINE_SINK_ID)) {
      markMotionSessionTerminal(turnId, messageId, terminal, reason);
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
    failDeferredText(
      timeline,
      `subtitle_audio_${terminal}_before_start:${reason}`,
    );
    if (terminal === "failed") {
      failTimelineSegment(timeline, reason);
      return;
    }
    const engine = timeline.engine;
    if (hasOpenSink(timeline, AUDIO_TIMELINE_SINK_ID)) {
      markAudioSessionTerminal(turnId, messageId, terminal, reason);
    }
    if (terminal === "interrupted") {
      failOpenMotionAfterAudioFailure(timeline, reason);
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
    failDeferredText(timeline, `subtitle_timeline_stopped:${reason}`);
    if (hasOpenSink(timeline, AUDIO_TIMELINE_SINK_ID)) {
      markAudioSessionTerminal(turnId, messageId, "interrupted", reason);
    }
    if (hasOpenSink(timeline, MOTION_TIMELINE_SINK_ID)) {
      markMotionSessionTerminal(turnId, messageId, "interrupted", reason);
    }
    timeline.engine.interrupt(reason);
    clearTimeline(turnId, messageId);
  }

  function stopTimelinesForTurn(turnId: string | null, reason: string): void {
    const normalizedTurnId = normalizeTurnId(turnId);
    for (const timeline of Array.from(timelines.values())) {
      if (normalizeTurnId(timeline.turnId) !== normalizedTurnId) {
        continue;
      }
      stopTimelineForSegment(timeline.turnId, timeline.messageId, reason);
    }
  }

  function stopAllTimelines(reason: string): void {
    for (const timeline of Array.from(timelines.values())) {
      stopTimelineForSegment(timeline.turnId, timeline.messageId, reason);
    }
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
      failDeferredText(timeline, "subtitle_audio_release_failed");
      clearTimeline(turnId, messageId);
    }
  }

  function releaseDeferredText(timeline: PlaybackTimelineEntry): boolean {
    const deferred = timeline.deferredText;
    if (!deferred) {
      return true;
    }
    timeline.deferredText = null;
    if (deferred.release()) {
      return true;
    }
    deferred.fail("subtitle_release_queue_invariant_failed");
    return false;
  }

  function failDeferredText(
    timeline: PlaybackTimelineEntry,
    reason: string,
  ): void {
    const deferred = timeline.deferredText;
    if (!deferred) {
      return;
    }
    timeline.deferredText = null;
    if (!deferred.fail(reason)) {
      deps.segmentExecution.session.markSessionFailed(
        timeline.turnId,
        `subtitle_failure_queue_invariant_failed:${timeline.messageId}`,
      );
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
      handleMissingTimelineEvent(event, sinkId, turnId, messageId, details);
      return null;
    }
    if (!timeline.engine.hasSink(sinkId)) {
      handleMissingSinkEvent(event, sinkId, turnId, messageId, details);
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
    closedTimelineKeys.delete(key);
    closedTimelineKeys.add(key);
    while (closedTimelineKeys.size > MAX_CLOSED_TIMELINE_KEYS) {
      const oldestKey = closedTimelineKeys.values().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      closedTimelineKeys.delete(oldestKey);
    }
  }

  function isTimelineTerminalPhase(timeline: PlaybackTimelineEntry): boolean {
    const phase = timeline.engine.getPhase();
    return phase === "completed" || phase === "failed" || phase === "interrupted";
  }

  function markAudioSessionTerminal(
    turnId: string | null,
    messageId: string,
    terminal: TimelineTerminal,
    reason: string,
  ): void {
    deps.audioSession?.markAudioTerminal(
      turnId,
      terminal === "completed" ? "completed" : "failed",
      messageId,
      reason,
    );
  }

  function markMotionSessionTerminal(
    turnId: string | null,
    messageId: string,
    terminal: TimelineTerminal,
    reason: string,
  ): void {
    if (terminal === "completed") {
      deps.motionSession?.markMotionCompleted(turnId, messageId);
      return;
    }
    deps.motionSession?.markMotionFailed(turnId, messageId, reason);
  }

  function failOpenMotionAfterAudioFailure(
    timeline: PlaybackTimelineEntry,
    reason: string,
  ): boolean {
    if (!hasOpenSink(timeline, MOTION_TIMELINE_SINK_ID)) {
      return false;
    }
    markMotionSessionTerminal(
      timeline.turnId,
      timeline.messageId,
      "failed",
      reason,
    );
    return true;
  }

  function failTimelineSegment(
    timeline: PlaybackTimelineEntry,
    reason: string,
  ): void {
    if (hasOpenSink(timeline, AUDIO_TIMELINE_SINK_ID)) {
      markAudioSessionTerminal(
        timeline.turnId,
        timeline.messageId,
        "failed",
        reason,
      );
    }
    if (hasOpenSink(timeline, MOTION_TIMELINE_SINK_ID)) {
      markMotionSessionTerminal(
        timeline.turnId,
        timeline.messageId,
        "failed",
        reason,
      );
    }
    timeline.engine.fail(reason);
    clearTimelineIfTerminal(timeline.turnId, timeline.messageId);
  }

  function hasOpenSink(
    timeline: PlaybackTimelineEntry,
    sinkId: string,
  ): boolean {
    const sink = timeline.engine.getSnapshot()?.sinks.find((item) =>
      item.id === sinkId
    );
    return Boolean(sink && !isTerminalSinkValue(sink.terminal));
  }

  function handleMissingTimelineEvent(
    event: string,
    sinkId: string,
    turnId: string | null,
    messageId: string,
    details: Record<string, unknown>,
  ): void {
    if (closedTimelineKeys.has(resolveTimelineKey(turnId, messageId))) {
      warnMissingTimeline(event, turnId, messageId, details);
      return;
    }
    reportMissingTimelineWiring(event, sinkId, turnId, messageId, details);
    markMissingRequiredSinkTerminal(event, sinkId, turnId, messageId);
  }

  function handleMissingSinkEvent(
    event: string,
    sinkId: string,
    turnId: string | null,
    messageId: string,
    details: Record<string, unknown>,
  ): void {
    reportMissingSinkWiring(event, sinkId, turnId, messageId, details);
    markMissingRequiredSinkTerminal(event, sinkId, turnId, messageId);
  }

  function markMissingRequiredSinkTerminal(
    event: string,
    sinkId: string,
    turnId: string | null,
    messageId: string,
  ): void {
    const reason = `playback_timeline_missing_${sinkId}_sink:${event}`;
    if (sinkId === AUDIO_TIMELINE_SINK_ID) {
      deps.audioSession?.markAudioTerminal(
        turnId,
        "failed",
        messageId,
        reason,
      );
      return;
    }
    if (sinkId === MOTION_TIMELINE_SINK_ID) {
      deps.motionSession?.markMotionFailed(turnId, messageId, reason);
    }
  }

  return {
    startSegmentJob,
    startAudioTimelineSink,
    startLipSyncTimelineSink,
    ensureMotionTimelineSinkForSegment: (turnId, messageId, onInterrupt) =>
      ensureMotionTimelineSink(turnId, messageId, { onInterrupt }),
    markAudioTimelineDuration,
    markAudioTimelineStarted,
    markLipSyncTimelineStarted,
    markLipSyncTimelineTerminal,
    markMotionTimelineStarted,
    markMotionTimelineTerminal,
    markAudioTimelineTerminal,
    stopTimelineForSegment,
    stopTimelinesForTurn,
    stopAllTimelines,
    getTimelineSnapshotForSegment,
    findActiveAudioTimelineSegments,
    findOpenAudioTimelineSegments,
  };
}

function normalizeTurnId(value: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function isTerminalSinkValue(value: string): boolean {
  return value !== "idle" && value !== "started";
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

function reportMissingTimelineWiring(
  event: string,
  sinkId: string,
  turnId: string | null,
  messageId: string,
  details: Record<string, unknown> = {},
): void {
  console.error(
    "[PlaybackTimelineRuntime] missing segment timeline for required lifecycle event.",
    {
      event,
      sinkId,
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

function reportMissingSinkWiring(
  event: string,
  sinkId: string,
  turnId: string | null,
  messageId: string,
  details: Record<string, unknown> = {},
): void {
  console.error(
    "[PlaybackTimelineRuntime] missing segment sink for lifecycle event.",
    {
      event,
      sinkId,
      turnId,
      messageId,
      ...details,
    },
  );
}
