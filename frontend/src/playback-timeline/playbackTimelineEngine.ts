import type {
  AudioPlaybackClock,
  PlaybackTimelineSinkDefinition,
  PlaybackTimelineSinkState,
  PlaybackTimelineSnapshot,
  SegmentPlaybackJob,
  SinkTerminal,
  TimelinePhase,
} from "./contracts.js";
import { createTimelineClock, type TimelineClock } from "./timelineClock.js";

interface PlaybackTimelineEngineOptions {
  now?: () => number;
  createTimelineId?: (job: SegmentPlaybackJob) => string;
}

interface RegisteredSink {
  definition: PlaybackTimelineSinkDefinition;
  state: PlaybackTimelineSinkState;
}

export interface PlaybackTimelineEngine {
  load(job: SegmentPlaybackJob, sinks?: PlaybackTimelineSinkDefinition[]): void;
  start(startedAtMs?: number): void;
  startSink(sinkId: string): boolean | void;
  pause(): void;
  resume(): void;
  stop(reason?: string): void;
  interrupt(reason: string): void;
  registerSink(sink: PlaybackTimelineSinkDefinition): void;
  hasSink(sinkId: string): boolean;
  attachAudioClock(clock: AudioPlaybackClock): void;
  detachAudioClock(): void;
  markSinkStarted(sinkId: string): void;
  markSinkTerminal(
    sinkId: string,
    terminal: Exclude<SinkTerminal, "idle">,
    reason?: string,
  ): void;
  setExpectedDurationMs(durationMs: number | null): void;
  getSnapshot(): PlaybackTimelineSnapshot | null;
  getPhase(): TimelinePhase;
}

function defaultTimelineId(job: SegmentPlaybackJob): string {
  return `${job.turnId ?? "preview"}:${job.messageId}`;
}

function createSinkState(
  definition: PlaybackTimelineSinkDefinition,
): PlaybackTimelineSinkState {
  return {
    id: definition.id,
    required: definition.required,
    terminal: definition.initialTerminal ?? "idle",
  };
}

function isTerminal(terminal: SinkTerminal): boolean {
  return terminal !== "idle" && terminal !== "started";
}

function isTerminalPhase(phase: TimelinePhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "interrupted";
}

export function createPlaybackTimelineEngine(
  options: PlaybackTimelineEngineOptions = {},
): PlaybackTimelineEngine {
  const createTimelineId = options.createTimelineId ?? defaultTimelineId;
  const clock: TimelineClock = createTimelineClock({ now: options.now });

  let job: SegmentPlaybackJob | null = null;
  let phase: TimelinePhase = "idle";
  let sinks = new Map<string, RegisteredSink>();

  function resetSinks(definitions: PlaybackTimelineSinkDefinition[] = []): void {
    sinks = new Map(
      definitions.map((definition) => [
        definition.id,
        {
          definition,
          state: createSinkState(definition),
        },
      ]),
    );
  }

  function getRegisteredSink(sinkId: string): RegisteredSink {
    const sink = sinks.get(sinkId);
    if (!sink) {
      throw new Error(`Unknown playback timeline sink: ${sinkId}`);
    }
    return sink;
  }

  function isReady(): boolean {
    if (sinks.size === 0) {
      return false;
    }
    for (const sink of sinks.values()) {
      if (sink.definition.required && sink.state.terminal === "idle") {
        return false;
      }
    }
    return true;
  }

  function updatePhaseFromTerminals(): void {
    if (!job) {
      phase = "idle";
      return;
    }
    let hasRequiredSink = false;
    let hasRequiredFailure = false;
    let allRequiredTerminal = true;
    for (const sink of sinks.values()) {
      if (!sink.definition.required) {
        continue;
      }
      hasRequiredSink = true;
      if (!isTerminal(sink.state.terminal)) {
        allRequiredTerminal = false;
      }
      if (
        sink.state.terminal === "failed"
        || sink.state.terminal === "interrupted"
      ) {
        hasRequiredFailure = true;
      }
    }
    if (!hasRequiredSink) {
      phase = "ready";
      return;
    }
    if (hasRequiredFailure && allRequiredTerminal) {
      phase = "failed";
      clock.stop();
      return;
    }
    if (allRequiredTerminal) {
      phase = "completed";
      clock.stop();
    }
  }

  function ensureLoaded(): SegmentPlaybackJob {
    if (!job) {
      throw new Error("Playback timeline is not loaded");
    }
    return job;
  }

  return {
    load(nextJob, definitions = []) {
      job = nextJob;
      phase = "preparing";
      resetSinks(definitions);
      clock.reset();
      if (isReady()) {
        phase = "ready";
      }
    },
    start(startedAtMs) {
      ensureLoaded();
      if (phase === "playing") {
        return;
      }
      if (phase !== "ready") {
        throw new Error(`Playback timeline cannot start from phase: ${phase}`);
      }
      if (!isReady()) {
        throw new Error("Playback timeline cannot start before required sinks are ready");
      }
      clock.start(startedAtMs);
      phase = "playing";
    },
    pause() {
      ensureLoaded();
      if (phase !== "playing") {
        return;
      }
      clock.pause();
      phase = "paused";
    },
    resume() {
      ensureLoaded();
      if (phase !== "paused") {
        return;
      }
      clock.resume();
      phase = "playing";
    },
    stop(reason = "stopped") {
      ensureLoaded();
      if (isTerminalPhase(phase)) {
        return;
      }
      phase = "stopping";
      clock.stop();
      for (const sink of sinks.values()) {
        if (isTerminal(sink.state.terminal)) {
          continue;
        }
        sink.state.terminal = "interrupted";
        sink.state.reason = reason;
      }
      phase = "interrupted";
    },
    interrupt(reason) {
      ensureLoaded();
      if (isTerminalPhase(phase)) {
        return;
      }
      phase = "stopping";
      clock.stop();
      for (const sink of sinks.values()) {
        if (isTerminal(sink.state.terminal)) {
          continue;
        }
        sink.definition.onInterrupt?.(reason);
        sink.state.terminal = "interrupted";
        sink.state.reason = reason;
      }
      phase = "interrupted";
    },
    registerSink(definition) {
      ensureLoaded();
      const existing = sinks.get(definition.id);
      if (existing) {
        existing.definition = {
          ...existing.definition,
          ...definition,
          start: definition.start ?? existing.definition.start,
          onInterrupt: definition.onInterrupt ?? existing.definition.onInterrupt,
        };
        existing.state.required = definition.required;
        if (phase === "preparing" && isReady()) {
          phase = "ready";
        }
        return;
      }
      sinks.set(definition.id, {
        definition,
        state: createSinkState(definition),
      });
      if (phase === "preparing" && isReady()) {
        phase = "ready";
      }
    },
    hasSink(sinkId) {
      ensureLoaded();
      return sinks.has(sinkId);
    },
    startSink(sinkId) {
      ensureLoaded();
      if (isTerminalPhase(phase)) {
        throw new Error(`Playback timeline sink cannot start from terminal phase: ${phase}`);
      }
      const sink = getRegisteredSink(sinkId);
      if (!sink.definition.start) {
        throw new Error(`Playback timeline sink has no start callback: ${sinkId}`);
      }
      return sink.definition.start();
    },
    attachAudioClock(audioClock) {
      ensureLoaded();
      clock.attachAudioClock(audioClock);
    },
    detachAudioClock() {
      ensureLoaded();
      clock.detachAudioClock();
    },
    markSinkStarted(sinkId) {
      ensureLoaded();
      if (isTerminalPhase(phase)) {
        return;
      }
      const sink = getRegisteredSink(sinkId);
      if (isTerminal(sink.state.terminal)) {
        return;
      }
      sink.state.terminal = "started";
      delete sink.state.reason;
      if (phase === "preparing" && isReady()) {
        phase = "ready";
      }
    },
    markSinkTerminal(sinkId, terminal, reason) {
      ensureLoaded();
      if (isTerminalPhase(phase)) {
        return;
      }
      const sink = getRegisteredSink(sinkId);
      if (isTerminal(sink.state.terminal)) {
        return;
      }
      sink.state.terminal = terminal;
      sink.state.reason = reason;
      if (phase === "preparing" && isReady()) {
        phase = "ready";
      }
      updatePhaseFromTerminals();
    },
    setExpectedDurationMs(durationMs) {
      clock.setExpectedDurationMs(durationMs);
    },
    getSnapshot() {
      if (!job) {
        return null;
      }
      const clockSnapshot = clock.snapshot();
      return {
        timelineId: createTimelineId(job),
        turnId: job.turnId,
        messageId: job.messageId,
        phase,
        clockSource: clockSnapshot.clockSource,
        startedAtMs: clockSnapshot.startedAtMs,
        currentTimeMs: clockSnapshot.currentTimeMs,
        durationMs: clockSnapshot.durationMs,
        playbackRate: clockSnapshot.playbackRate,
        sinks: Array.from(sinks.values()).map((sink) => ({
          ...sink.state,
        })),
      };
    },
    getPhase() {
      return phase;
    },
  };
}
