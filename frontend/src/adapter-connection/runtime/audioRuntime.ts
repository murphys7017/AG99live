import type { PlaybackTimelineAudioSink } from "../../playback-timeline/audioSink.js";
import type {
  PlaybackTimelineLipSyncRuntime,
  PlaybackTimelineLipSyncRuntimeCallbacks,
} from "../../playback-timeline/lipSyncSink.js";
import type {
  PlaybackTimelineRuntime,
} from "../../playback-timeline/playbackTimelineRuntime.js";
import type { PlaybackTimelineSnapshot } from "../../playback-timeline/contracts.js";
import {
  createAdapterAudioTimelineController,
} from "./audioTimelineController.js";
import type { AudioPlaybackTerminalState } from "./audioPlaybackStateBridge.js";
import {
  createAdapterAudioSettlementController,
} from "./audioSettlementController.js";
import type { NormalizedMotionPayload } from "../../playback-integrations/motionPayload.js";

export interface AdapterAudioRuntimeState {
  isPlayingAudio: boolean;
  currentTurnId: string | null;
  statusMessage: string;
  lastError: string;
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackStartedMessageId: string | null;
  audioPlaybackStartedAtMs: number;
  audioPlaybackDurationMs: number | null;
  audioPlaybackTerminalState: AudioPlaybackTerminalState;
  audioPlaybackTerminalTurnId: string | null;
  audioPlaybackTerminalReason: string;
}

export interface AdapterAudioRuntimeDeps {
  state: AdapterAudioRuntimeState;
  audioSink: PlaybackTimelineAudioSink;
  playbackTimelineRuntime: PlaybackTimelineRuntime<NormalizedMotionPayload>;
  pushHistory: (role: string, text: string) => void;
  createLipSyncRuntime?: (
    callbacks: PlaybackTimelineLipSyncRuntimeCallbacks,
  ) => PlaybackTimelineLipSyncRuntime;
}

export interface ActiveAudioSegment {
  turnId: string | null;
  messageId: string;
}

export interface AdapterAudioRuntime {
  releaseAudioForTimelinePlayback: (
    audioUrl: string,
    messageId: string,
    turnId: string | null,
  ) => boolean;
  startSegmentJob: PlaybackTimelineRuntime<NormalizedMotionPayload>["startSegmentJob"];
  rejectAudioBeforeStart: PlaybackTimelineRuntime<NormalizedMotionPayload>["rejectAudioBeforeStart"];
  rejectMotionBeforeStart: PlaybackTimelineRuntime<NormalizedMotionPayload>["rejectMotionBeforeStart"];
  resetAudioPlaybackTerminal: () => void;
  stopAudioAndSettleTurn: (turnId: string | null, reason: string) => void;
  stopAudioAndSettleAll: (reason: string) => void;
  findActiveAudioSegment: () => ActiveAudioSegment | null;
  findOpenAudioSegment: () => ActiveAudioSegment | null;
  findOpenExecutionSegment: () => ActiveAudioSegment | null;
  getPlaybackTimelineSnapshotForSegment: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineSnapshot | null;
  ensureMotionTimelineSinkForSegment: (
    turnId: string | null,
    messageId: string,
    onInterrupt?: (reason: string) => void,
  ) => boolean;
  markMotionTimelineStarted: (
    turnId: string | null,
    messageId: string,
  ) => void;
  markMotionTimelineTerminal: (
    turnId: string | null,
    messageId: string,
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ) => void;
}

export function createAdapterAudioRuntime(
  deps: AdapterAudioRuntimeDeps,
): AdapterAudioRuntime {
  const timelineController = createAdapterAudioTimelineController<NormalizedMotionPayload>({
    state: deps.state,
    audioSink: deps.audioSink,
    playbackTimelineRuntime: deps.playbackTimelineRuntime,
    pushHistory: deps.pushHistory,
    createLipSyncRuntime: deps.createLipSyncRuntime,
    markTerminal: markAudioPlaybackTerminalState,
    resetTerminal: resetAudioPlaybackTerminal,
  });
  const { playbackTimelineRuntime } = timelineController;
  const {
    startSegmentJob,
    rejectAudioBeforeStart,
    rejectMotionBeforeStart,
    markMotionTimelineStarted,
    markMotionTimelineTerminal,
    ensureMotionTimelineSinkForSegment,
    findActiveAudioTimelineSegments,
    findOpenAudioTimelineSegments,
    findOpenExecutionTimelineSegments,
    getTimelineSnapshotForSegment: getPlaybackTimelineSnapshotForSegment,
  } = playbackTimelineRuntime;

  function markAudioPlaybackTerminalState(
    terminalState: Exclude<AudioPlaybackTerminalState, "idle">,
    turnId: string | null,
    reason = "",
    _messageId: string | null = null,
  ): void {
    deps.state.audioPlaybackTerminalState = terminalState;
    deps.state.audioPlaybackTerminalTurnId = turnId;
    deps.state.audioPlaybackTerminalReason = reason;
  }

  function resetAudioPlaybackTerminal(): void {
    deps.state.audioPlaybackTerminalState = "idle";
    deps.state.audioPlaybackTerminalTurnId = null;
    deps.state.audioPlaybackTerminalReason = "";
  }

  async function startAudioSegmentPlayback(
    audioUrl: string,
    turnId: string | null,
    messageId: string,
  ): Promise<void> {
    return timelineController.startAudioSegmentPlayback(audioUrl, turnId, messageId);
  }

  function releaseAudioForTimelinePlayback(
    audioUrl: string,
    messageId: string,
    turnId: string | null,
  ): boolean {
    if (!audioUrl.trim()) {
      return false;
    }
    void startAudioSegmentPlayback(audioUrl, turnId, messageId);
    return true;
  }

  function stopAudioPlayback(
    turnId: string | null,
    messageId: string | null,
    reason: string,
  ): void {
    timelineController.stopAudioPlaybackForSegment(turnId, messageId, reason);
  }

  const audioSettlementController = createAdapterAudioSettlementController({
    findOpenAudioSegments,
    stopAudioPlayback,
    stopTimelinesForTurn: playbackTimelineRuntime.stopTimelinesForTurn,
    stopAllTimelines: playbackTimelineRuntime.stopAllTimelines,
  });

  function findActiveAudioSegment(): ActiveAudioSegment | null {
    return findActiveAudioSegments()[0] ?? null;
  }

  function findActiveAudioSegments(): ActiveAudioSegment[] {
    return findActiveAudioTimelineSegments();
  }

  function findOpenAudioSegments(): ActiveAudioSegment[] {
    return findOpenAudioTimelineSegments();
  }

  function findOpenExecutionSegment(): ActiveAudioSegment | null {
    return findOpenExecutionTimelineSegments()[0] ?? null;
  }

  return {
    releaseAudioForTimelinePlayback,
    startSegmentJob,
    rejectAudioBeforeStart,
    rejectMotionBeforeStart,
    resetAudioPlaybackTerminal,
    stopAudioAndSettleTurn: audioSettlementController.stopAudioAndSettleTurn,
    stopAudioAndSettleAll: audioSettlementController.stopAudioAndSettleAll,
    findActiveAudioSegment,
    findOpenAudioSegment: audioSettlementController.findOpenAudioSegment,
    findOpenExecutionSegment,
    getPlaybackTimelineSnapshotForSegment,
    ensureMotionTimelineSinkForSegment,
    markMotionTimelineStarted,
    markMotionTimelineTerminal,
  };
}
