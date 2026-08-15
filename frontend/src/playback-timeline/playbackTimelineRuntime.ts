import type {
  AudioPlaybackClock,
  PlaybackTimelineClockReader,
  PlaybackTimelineSnapshot,
} from "./contracts.js";
import {
  createPlaybackTimelineEngine,
  type PlaybackTimelineEngine,
} from "./playbackTimelineEngine.js";
import type {
  PlaybackTimelineSegmentExecutionPorts,
  PlaybackTimelineSegmentJob,
} from "./segmentJob.js";
import {
  executePlaybackTimelineSegmentJob,
  type PlaybackTimelineDeferredTextRelease,
  type PlaybackTimelineSegmentExecutorTimelinePort,
} from "./segmentJobExecutor.js";
import {
  createPlaybackTimelineSessionProjection,
  type PlaybackTimelineAudioSessionPort,
  type PlaybackTimelineMotionSessionPort,
  type PlaybackTimelineTerminal,
} from "./sessionProjection.js";

export type {
  PlaybackTimelineAudioSessionPort,
  PlaybackTimelineMotionSessionPort,
} from "./sessionProjection.js";

const AUDIO_TIMELINE_SINK_ID = "audio";
export const AUDIO_TIMELINE_START_TIMEOUT_MS = 3000;
const LIP_SYNC_TIMELINE_SINK_ID = "lip_sync";
const MAX_CLOSED_TIMELINE_KEYS = 512;
const MOTION_TIMELINE_SINK_ID = "motion";

type TimelineTerminal = PlaybackTimelineTerminal;

interface PlaybackTimelineEntry {
  turnId: string | null;
  messageId: string;
  engine: PlaybackTimelineEngine;
  projectsMotionSession: boolean;
  deferredText: PlaybackTimelineDeferredTextRelease | null;
  audioStartTimeoutHandle: ReturnType<typeof globalThis.setTimeout> | null;
  audioInterruptHandler: ((reason: string) => void) | null;
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

export interface PlaybackTimelineExecutionSegment {
  turnId: string | null;
  messageId: string;
}

export interface PlaybackTimelineRuntimeDeps<TMotionPayload = unknown> {
  segmentExecution: PlaybackTimelineSegmentExecutionPorts<TMotionPayload>;
  audioSession?: PlaybackTimelineAudioSessionPort;
  motionSession?: PlaybackTimelineMotionSessionPort;
  onAudioTimelineStarted?: (
    turnId: string | null,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot,
  ) => void;
  onAudioTimelineDurationReady?: (
    turnId: string | null,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot,
  ) => void;
}

export interface PlaybackTimelineRuntime<TMotionPayload = unknown> {
  startSegmentJob: (
    job: PlaybackTimelineSegmentJob<TMotionPayload>,
  ) => void;
  rejectMotionBeforeStart: (
    turnId: string | null,
    messageId: string,
    reason: string,
  ) => void;
  rejectAudioBeforeStart: (
    turnId: string | null,
    messageId: string,
    reason: string,
  ) => void;
  startAudioTimelineSink: (
    turnId: string | null,
    messageId: string,
    options: PlaybackTimelineSinkStartOptions,
  ) => boolean | void;
  setAudioTimelineInterruptHandler: (
    turnId: string | null,
    messageId: string,
    onInterrupt: (reason: string) => void,
  ) => void;
  startLipSyncTimelineSink: (
    turnId: string | null,
    messageId: string,
    start: () => boolean | void,
  ) => boolean | void;
  attachAudioTimelineClock: (
    turnId: string | null,
    messageId: string,
    audioClock: AudioPlaybackClock,
  ) => void;
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
    audioClock: AudioPlaybackClock,
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
  getTimelineClockReaderForSegment: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineClockReader | null;
  subscribeExecutionStateChanges: (
    listener: () => void,
  ) => () => void;
  findActiveAudioTimelineSegments: () => PlaybackTimelineAudioSegment[];
  findOpenAudioTimelineSegments: () => PlaybackTimelineAudioSegment[];
  findOpenExecutionTimelineSegments: () => PlaybackTimelineExecutionSegment[];
}

export function createPlaybackTimelineRuntime<TMotionPayload = unknown>(
  deps: PlaybackTimelineRuntimeDeps<TMotionPayload>,
): PlaybackTimelineRuntime<TMotionPayload> {
  const timelines = new Map<string, PlaybackTimelineEntry>();
  const closedTimelineKeys = new Set<string>();
  const executionStateListeners = new Set<() => void>();
  const sessionProjection = createPlaybackTimelineSessionProjection({
    audioSession: deps.audioSession,
    motionSession: deps.motionSession,
  });

  function notifyExecutionStateChanged(): void {
    for (const listener of executionStateListeners) {
      listener();
    }
  }

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
      if (options.onInterrupt) {
        existing.audioInterruptHandler = options.onInterrupt;
      }
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
    const entry: PlaybackTimelineEntry = {
      turnId,
      messageId,
      engine,
      projectsMotionSession: false,
      deferredText: options.deferredText ?? null,
      audioStartTimeoutHandle: null,
      audioInterruptHandler: options.onInterrupt ?? null,
    };
    engine.load(
      { turnId, messageId },
      [
        {
          id: AUDIO_TIMELINE_SINK_ID,
          required: true,
          start: options.start,
          onInterrupt: (reason) => entry.audioInterruptHandler?.(reason),
        },
        { id: LIP_SYNC_TIMELINE_SINK_ID, required: false },
      ],
    );
    setTimeline(turnId, messageId, entry);
  }

  function ensureAudioSegmentTimeline(
    turnId: string | null,
    messageId: string,
    options: {
      hasMotion: boolean;
    },
  ): boolean {
    prepareAudioTimeline(turnId, messageId);
    const timeline = getTimeline(turnId, messageId);
    if (!timeline) {
      return false;
    }
    if (options.hasMotion) {
      timeline.projectsMotionSession = true;
      return ensureMotionTimelineSink(turnId, messageId);
    }
    return true;
  }

  function startAudioTimelineSink(
    turnId: string | null,
    messageId: string,
    options: PlaybackTimelineSinkStartOptions,
  ): boolean | void {
    prepareAudioTimeline(turnId, messageId, options);
    const timeline = getTimeline(turnId, messageId);
    if (!timeline) {
      throw new Error("Playback timeline missing after audio sink preparation.");
    }
    armAudioStartTimeout(timeline);
    let accepted: boolean | void;
    try {
      accepted = startTimelineSink(
        turnId,
        messageId,
        AUDIO_TIMELINE_SINK_ID,
      );
    } catch (error) {
      clearAudioStartTimeout(timeline);
      throw error;
    }
    if (accepted === false) {
      clearAudioStartTimeout(timeline);
    }
    return accepted;
  }

  function setAudioTimelineInterruptHandler(
    turnId: string | null,
    messageId: string,
    onInterrupt: (reason: string) => void,
  ): void {
    const timeline = getTimelineWithSink(
      "audio.interrupt_handler",
      AUDIO_TIMELINE_SINK_ID,
      turnId,
      messageId,
    );
    if (!timeline) {
      throw new Error("Playback timeline audio sink is missing before player start.");
    }
    timeline.audioInterruptHandler = onInterrupt;
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
  ): void {
    executePlaybackTimelineSegmentJob({
      job,
      ports: deps.segmentExecution,
      timeline: segmentExecutorTimelinePort,
    });
    notifyExecutionStateChanged();
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
    rejectMotionBeforeStart,
    rejectAudioBeforeStart,
  };

  function rejectAudioBeforeStart(
    turnId: string | null,
    messageId: string,
    reason: string,
  ): void {
    const key = resolveTimelineKey(turnId, messageId);
    if (!sessionProjection.claimAudioRejection(key)) {
      return;
    }
    const timeline = getTimeline(turnId, messageId);
    if (timeline?.engine.hasSink(AUDIO_TIMELINE_SINK_ID)) {
      const audioSink = timeline.engine.getSnapshot()?.sinks.find(
        (sink) => sink.id === AUDIO_TIMELINE_SINK_ID,
      );
      if (audioSink && !isTerminalSinkValue(audioSink.terminal)) {
        markAudioTimelineTerminal(turnId, messageId, "failed", reason);
      }
      return;
    }
    sessionProjection.markAudioTerminal(
      turnId,
      messageId,
      "failed",
      reason,
    );
  }

  function rejectMotionBeforeStart(
    turnId: string | null,
    messageId: string,
    reason: string,
  ): void {
    const key = resolveTimelineKey(turnId, messageId);
    if (!sessionProjection.claimMotionRejection(key)) {
      return;
    }
    const timeline = getTimeline(turnId, messageId);
    if (timeline) {
      const motionSink = timeline.engine.getSnapshot()?.sinks.find(
        (sink) => sink.id === MOTION_TIMELINE_SINK_ID,
      );
      if (motionSink && !isTerminalSinkValue(motionSink.terminal)) {
        markMotionTimelineTerminal(turnId, messageId, "failed", reason);
        return;
      }
      if (motionSink) {
        return;
      }
      if (!timeline.projectsMotionSession) {
        return;
      }
    }
    sessionProjection.markMotionTerminal(
      turnId,
      messageId,
      "failed",
      reason,
    );
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

  function ensureMotionOnlyTimeline(
    turnId: string | null,
    messageId: string,
    options: PlaybackTimelineSinkStartOptions = {},
  ): PlaybackTimelineSnapshot | null {
    const existing = getTimeline(turnId, messageId);
    if (existing) {
      existing.projectsMotionSession = true;
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
      projectsMotionSession: true,
      deferredText: null,
      audioStartTimeoutHandle: null,
      audioInterruptHandler: null,
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
    sessionProjection.markAudioDuration(
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
    audioClock: AudioPlaybackClock,
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
    clearAudioStartTimeout(timeline);
    engine.setExpectedDurationMs(durationMs);
    engine.attachAudioClock(audioClock);
    engine.markSinkStarted(AUDIO_TIMELINE_SINK_ID);
    if (engine.getPhase() === "ready") {
      engine.start(startedAtMs);
    }
    sessionProjection.markAudioStarted(
      turnId,
      messageId,
      startedAtMs,
      durationMs,
    );
    if (!releaseDeferredText(timeline)) {
      failTimelineSegment(timeline, "subtitle_sink_release_failed");
      deps.segmentExecution.session.markSessionFailed(
        turnId,
        `subtitle_sink_release_failed:${messageId}`,
      );
      return false;
    }
    const snapshot = engine.getSnapshot();
    if (!snapshot) {
      throw new Error("Playback timeline snapshot missing after audio start.");
    }
    deps.onAudioTimelineStarted?.(turnId, messageId, snapshot);
    return true;
  }

  function attachAudioTimelineClock(
    turnId: string | null,
    messageId: string,
    audioClock: AudioPlaybackClock,
  ): void {
    const timeline = getTimelineWithSink(
      "audio.clock_attached",
      AUDIO_TIMELINE_SINK_ID,
      turnId,
      messageId,
    );
    if (!timeline) {
      throw new Error(
        `Playback timeline missing while attaching audio clock: ${messageId}`,
      );
    }
    timeline.engine.attachAudioClock(audioClock);
    console.info("[PlaybackTimeline] audio clock attached before playback.", {
      turnId,
      messageId,
      timelineId: timeline.engine.getSnapshot()?.timelineId ?? null,
    });
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
    if (
      timeline.projectsMotionSession
      && hasOpenSink(timeline, MOTION_TIMELINE_SINK_ID)
    ) {
      sessionProjection.markMotionStarted(turnId, messageId);
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
    notifyExecutionStateChanged();
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
    notifyExecutionStateChanged();
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

  function getTimelineClockReaderForSegment(
    turnId: string | null,
    messageId: string,
  ): PlaybackTimelineClockReader | null {
    const entry = getTimeline(turnId, messageId);
    if (!entry) {
      return null;
    }
    return {
      getSnapshot: () => {
        if (getTimeline(turnId, messageId) !== entry) {
          return null;
        }
        return entry.engine.getSnapshot();
      },
    };
  }

  function subscribeExecutionStateChanges(
    listener: () => void,
  ): () => void {
    executionStateListeners.add(listener);
    return () => executionStateListeners.delete(listener);
  }

  function findActiveAudioTimelineSegments(): PlaybackTimelineAudioSegment[] {
    return findAudioTimelineSegments((audioSink) => audioSink?.terminal === "started");
  }

  function findOpenAudioTimelineSegments(): PlaybackTimelineAudioSegment[] {
    return findAudioTimelineSegments((audioSink) =>
      audioSink?.terminal === "idle" || audioSink?.terminal === "started"
    );
  }

  function findOpenExecutionTimelineSegments(): PlaybackTimelineExecutionSegment[] {
    const segments: PlaybackTimelineExecutionSegment[] = [];
    for (const timeline of timelines.values()) {
      const snapshot = timeline.engine.getSnapshot();
      if (!snapshot || isTimelineTerminalPhase(timeline)) {
        continue;
      }
      if (!snapshot.sinks.some((sink) => sink.required && !isTerminalSinkValue(sink.terminal))) {
        continue;
      }
      segments.push({
        turnId: timeline.turnId,
        messageId: timeline.messageId,
      });
    }
    return segments;
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
    deferred.fail("subtitle_sink_release_failed");
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
        `subtitle_failure_projection_failed:${timeline.messageId}`,
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
    const timeline = timelines.get(key);
    if (timeline) {
      clearAudioStartTimeout(timeline);
      timelines.delete(key);
    }
    rememberBoundedKey(closedTimelineKeys, key);
    notifyExecutionStateChanged();
  }

  function armAudioStartTimeout(timeline: PlaybackTimelineEntry): void {
    clearAudioStartTimeout(timeline);
    const timeoutHandle = globalThis.setTimeout(() => {
      const activeTimeline = getTimeline(timeline.turnId, timeline.messageId);
      if (activeTimeline !== timeline || !hasOpenSink(timeline, AUDIO_TIMELINE_SINK_ID)) {
        return;
      }
      console.error("[PlaybackTimelineRuntime] audio did not reach playing before deadline.", {
        turnId: timeline.turnId,
        messageId: timeline.messageId,
        timeoutMs: AUDIO_TIMELINE_START_TIMEOUT_MS,
      });
      failDeferredText(timeline, "subtitle_audio_start_timeout");
      failTimelineSegment(timeline, "audio_start_timeout");
    }, AUDIO_TIMELINE_START_TIMEOUT_MS);
    // Node-based tests must not remain alive solely for a browser playback deadline.
    const nodeTimeoutHandle = timeoutHandle as unknown as { unref?: () => void };
    nodeTimeoutHandle.unref?.();
    timeline.audioStartTimeoutHandle = timeoutHandle;
  }

  function clearAudioStartTimeout(timeline: PlaybackTimelineEntry): void {
    if (timeline.audioStartTimeoutHandle === null) {
      return;
    }
    globalThis.clearTimeout(timeline.audioStartTimeoutHandle);
    timeline.audioStartTimeoutHandle = null;
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
    sessionProjection.markAudioTerminal(
      turnId,
      messageId,
      terminal,
      reason,
    );
  }

  function markMotionSessionTerminal(
    turnId: string | null,
    messageId: string,
    terminal: TimelineTerminal,
    reason: string,
  ): void {
    const timeline = getTimeline(turnId, messageId);
    if (timeline && !timeline.projectsMotionSession) {
      return;
    }
    sessionProjection.markMotionTerminal(turnId, messageId, terminal, reason);
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
      rejectAudioBeforeStart(turnId, messageId, reason);
      return;
    }
    if (sinkId === MOTION_TIMELINE_SINK_ID) {
      rejectMotionBeforeStart(turnId, messageId, reason);
    }
  }

  return {
    startSegmentJob,
    rejectAudioBeforeStart,
    rejectMotionBeforeStart,
    startAudioTimelineSink,
    setAudioTimelineInterruptHandler,
    startLipSyncTimelineSink,
    attachAudioTimelineClock,
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
    getTimelineClockReaderForSegment,
    subscribeExecutionStateChanges,
    findActiveAudioTimelineSegments,
    findOpenAudioTimelineSegments,
    findOpenExecutionTimelineSegments,
  };
}

function rememberBoundedKey(keys: Set<string>, key: string): void {
  keys.delete(key);
  keys.add(key);
  while (keys.size > MAX_CLOSED_TIMELINE_KEYS) {
    const oldestKey = keys.values().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    keys.delete(oldestKey);
  }
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
