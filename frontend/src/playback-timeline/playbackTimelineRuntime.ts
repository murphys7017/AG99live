import type {
  AudioPlaybackClock,
  PlaybackTimelineSnapshot,
} from "./contracts.js";
import {
  createPlaybackTimelineEngine,
  type PlaybackTimelineEngine,
} from "./playbackTimelineEngine.js";

const AUDIO_TIMELINE_SINK_ID = "audio";
const LIP_SYNC_TIMELINE_SINK_ID = "lip_sync";
const MOTION_TIMELINE_SINK_ID = "motion";

type TimelineTerminal = "completed" | "failed" | "interrupted";

interface ActivePlaybackTimeline {
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

export interface PlaybackTimelineRuntime {
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
  stopActiveTimeline: (reason: string) => void;
  getActiveTimelineSnapshot: () => PlaybackTimelineSnapshot | null;
  getTimelineSnapshotForSegment: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineSnapshot | null;
}

export function createPlaybackTimelineRuntime(
  deps: PlaybackTimelineRuntimeDeps,
): PlaybackTimelineRuntime {
  let activeTimeline: ActivePlaybackTimeline | null = null;

  function isActiveTimeline(
    turnId: string | null,
    messageId: string,
  ): boolean {
    return Boolean(
      activeTimeline
      && activeTimeline.messageId === messageId
      && matchesTimelineTurn(activeTimeline.turnId, turnId),
    );
  }

  function prepareAudioTimeline(
    turnId: string | null,
    messageId: string,
  ): void {
    const engine = createPlaybackTimelineEngine();
    engine.load(
      { turnId, messageId },
      [
        { id: AUDIO_TIMELINE_SINK_ID, required: true },
        { id: LIP_SYNC_TIMELINE_SINK_ID, required: false },
      ],
    );
    activeTimeline = {
      turnId,
      messageId,
      engine,
    };
  }

  function prepareMotionOnlyTimeline(
    turnId: string | null,
    messageId: string,
  ): PlaybackTimelineSnapshot | null {
    if (isActiveTimeline(turnId, messageId) && activeTimeline) {
      return prepareMotionTimelineSink(turnId, messageId)
        ? activeTimeline.engine.getSnapshot()
        : null;
    }
    if (activeTimeline) {
      return null;
    }
    const engine = createPlaybackTimelineEngine();
    engine.load(
      { turnId, messageId },
      [
        { id: MOTION_TIMELINE_SINK_ID, required: true },
      ],
    );
    activeTimeline = {
      turnId,
      messageId,
      engine,
    };
    return engine.getSnapshot();
  }

  function markAudioTimelineDuration(
    turnId: string | null,
    messageId: string,
    durationMs: number | null,
  ): void {
    if (!isActiveTimeline(turnId, messageId)) {
      return;
    }
    activeTimeline?.engine.setExpectedDurationMs(durationMs);
  }

  function markAudioTimelineStarted(
    turnId: string | null,
    messageId: string,
    startedAtMs: number,
    durationMs: number | null,
  ): void {
    if (!isActiveTimeline(turnId, messageId) || !activeTimeline) {
      return;
    }
    const engine = activeTimeline.engine;
    engine.setExpectedDurationMs(durationMs);
    const audioClock = deps.getAudioClock();
    if (audioClock) {
      engine.attachAudioClock(audioClock);
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
    if (!isActiveTimeline(turnId, messageId) || !activeTimeline) {
      return;
    }
    activeTimeline.engine.markSinkStarted(LIP_SYNC_TIMELINE_SINK_ID);
  }

  function markLipSyncTimelineTerminal(
    turnId: string | null,
    messageId: string,
    terminal: TimelineTerminal,
    reason: string,
  ): void {
    if (!isActiveTimeline(turnId, messageId) || !activeTimeline) {
      return;
    }
    activeTimeline.engine.markSinkTerminal(
      LIP_SYNC_TIMELINE_SINK_ID,
      terminal,
      reason,
    );
  }

  function prepareMotionTimelineSink(
    turnId: string | null,
    messageId: string,
  ): boolean {
    if (!isActiveTimeline(turnId, messageId) || !activeTimeline) {
      return false;
    }
    const engine = activeTimeline.engine;
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
    if (!prepareMotionTimelineSink(turnId, messageId) || !activeTimeline) {
      return;
    }
    const engine = activeTimeline.engine;
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
    if (!prepareMotionTimelineSink(turnId, messageId) || !activeTimeline) {
      return;
    }
    activeTimeline.engine.markSinkTerminal(
      MOTION_TIMELINE_SINK_ID,
      terminal,
      reason,
    );
    clearActiveTimelineIfTerminal();
  }

  function markAudioTimelineTerminal(
    turnId: string | null,
    messageId: string,
    terminal: TimelineTerminal,
    reason: string,
  ): void {
    if (!isActiveTimeline(turnId, messageId) || !activeTimeline) {
      return;
    }
    const engine = activeTimeline.engine;
    if (terminal === "interrupted") {
      engine.interrupt(reason);
    } else {
      engine.detachAudioClock();
      engine.markSinkTerminal(AUDIO_TIMELINE_SINK_ID, terminal, reason);
    }
    clearActiveTimelineIfTerminal();
  }

  function stopActiveTimeline(reason: string): void {
    if (!activeTimeline) {
      return;
    }
    activeTimeline.engine.interrupt(reason);
    activeTimeline = null;
  }

  function getActiveTimelineSnapshot(): PlaybackTimelineSnapshot | null {
    return activeTimeline?.engine.getSnapshot() ?? null;
  }

  function getTimelineSnapshotForSegment(
    turnId: string | null,
    messageId: string,
  ): PlaybackTimelineSnapshot | null {
    if (!isActiveTimeline(turnId, messageId)) {
      return null;
    }
    return activeTimeline?.engine.getSnapshot() ?? null;
  }

  function clearActiveTimelineIfTerminal(): void {
    if (isTimelineTerminalPhase()) {
      activeTimeline = null;
    }
  }

  function isTimelineTerminalPhase(): boolean {
    const phase = activeTimeline?.engine.getPhase();
    return phase === "completed" || phase === "failed" || phase === "interrupted";
  }

  return {
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
    stopActiveTimeline,
    getActiveTimelineSnapshot,
    getTimelineSnapshotForSegment,
  };
}

function matchesTimelineTurn(
  candidateTurnId: string | null,
  targetTurnId: string | null,
): boolean {
  const normalizedCandidateTurnId = normalizeTurnId(candidateTurnId);
  const normalizedTargetTurnId = normalizeTurnId(targetTurnId);
  if (!normalizedCandidateTurnId && !normalizedTargetTurnId) {
    return true;
  }
  return Boolean(
    normalizedCandidateTurnId
    && normalizedTargetTurnId
    && normalizedCandidateTurnId === normalizedTargetTurnId,
  );
}

function normalizeTurnId(value: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}
