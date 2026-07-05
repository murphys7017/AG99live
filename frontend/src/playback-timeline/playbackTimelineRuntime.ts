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
} from "./segmentJobExecutor.js";
import {
  startPlaybackTimelineSegmentJob,
} from "./segmentJobExecutor.js";
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
  setSegmentExecutionPorts: (
    ports: PlaybackTimelineSegmentExecutionPorts<NormalizedMotionPayload>,
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
  ) => void;
  prepareMotionOnlyTimeline: (
    turnId: string | null,
    messageId: string,
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
}

export function createPlaybackTimelineRuntime(
  deps: PlaybackTimelineRuntimeDeps,
): PlaybackTimelineRuntime {
  const timelines = new Map<string, PlaybackTimelineEntry>();
  let segmentExecutionPorts: PlaybackTimelineSegmentExecutionPorts<NormalizedMotionPayload> | null = null;

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
  ): void {
    const existing = getTimeline(turnId, messageId);
    if (existing?.engine.hasSink(AUDIO_TIMELINE_SINK_ID)) {
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
        { id: AUDIO_TIMELINE_SINK_ID, required: true },
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

  function setSegmentExecutionPorts(
    ports: PlaybackTimelineSegmentExecutionPorts<NormalizedMotionPayload>,
  ): void {
    segmentExecutionPorts = ports;
  }

  function startSegmentJob(
    job: PlaybackTimelineSegmentJob<NormalizedMotionPayload>,
  ): PlaybackTimelineSegmentExecutionResult {
    if (!segmentExecutionPorts) {
      throw new Error("Playback timeline segment execution ports are not configured.");
    }
    return startPlaybackTimelineSegmentJob(
      job,
      segmentExecutionPorts,
      { prepareSegmentJob },
    );
  }

  function prepareMotionOnlyTimeline(
    turnId: string | null,
    messageId: string,
  ): PlaybackTimelineSnapshot | null {
    const existing = getTimeline(turnId, messageId);
    if (existing) {
      return prepareMotionTimelineSink(turnId, messageId)
        ? existing.engine.getSnapshot()
        : null;
    }
    const engine = createPlaybackTimelineEngine();
    engine.load(
      { turnId, messageId },
      [
        { id: MOTION_TIMELINE_SINK_ID, required: true },
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
    const timeline = getTimeline(turnId, messageId);
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
    const timeline = getTimeline(turnId, messageId);
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
    const timeline = getTimeline(turnId, messageId);
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
    const timeline = getTimeline(turnId, messageId);
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
      });
    }
    return true;
  }

  function markMotionTimelineStarted(
    turnId: string | null,
    messageId: string,
  ): void {
    if (!prepareMotionTimelineSink(turnId, messageId)) {
      console.warn("[PlaybackTimelineRuntime] dropped motion started event without active timeline.", {
        turnId,
        messageId,
      });
      return;
    }
    const timeline = getTimeline(turnId, messageId);
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
    if (!prepareMotionTimelineSink(turnId, messageId)) {
      console.warn("[PlaybackTimelineRuntime] dropped motion terminal event without active timeline.", {
        turnId,
        messageId,
        terminal,
        reason,
      });
      return;
    }
    const timeline = getTimeline(turnId, messageId);
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
    const timeline = getTimeline(turnId, messageId);
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
    setSegmentExecutionPorts,
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
