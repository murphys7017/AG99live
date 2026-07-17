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
import type { PendingAudioItem } from "../../playback-timeline/playbackReleaseQueue.js";
import {
  createPlaybackTimelineAudioReleaseController,
} from "../../playback-timeline/audioReleaseController.js";
import {
  createAdapterAudioSettlementController,
} from "./audioSettlementController.js";
import type { NormalizedMotionPayload } from "../../playback-integrations/motionPayload.js";

export interface AdapterAudioRuntimeState {
  isPlayingAudio: boolean;
  currentTurnId: string | null;
  statusMessage: string;
  lastError: string;
  pendingAudios: Map<string, PendingAudioItem>;
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
  queueAudioForPlayback: (
    audioUrl: string,
    turnId: string | null,
    messageId: string,
  ) => void;
  releaseQueuedAudioForTimelinePlayback: (
    messageId: string,
    turnId: string | null,
  ) => boolean;
  startSegmentJob: PlaybackTimelineRuntime<NormalizedMotionPayload>["startSegmentJob"];
  rejectAudioBeforeStart: PlaybackTimelineRuntime<NormalizedMotionPayload>["rejectAudioBeforeStart"];
  rejectMotionBeforeStart: PlaybackTimelineRuntime<NormalizedMotionPayload>["rejectMotionBeforeStart"];
  hasPendingAudioForTurn: (turnId: string | null) => boolean;
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

  const audioReleaseController = createPlaybackTimelineAudioReleaseController({
    state: deps.state,
    startAudioPlayback: (audioUrl, turnId, messageId) => {
      void startAudioSegmentPlayback(
        audioUrl,
        turnId,
        messageId,
      );
    },
    onAudioQueued: () => {
      deps.state.statusMessage = "收到语音回复，等待同步播放。";
      deps.pushHistory("system", deps.state.statusMessage);
    },
  });

  function releaseQueuedAudioForTimelinePlayback(
    messageId: string,
    turnId: string | null,
  ): boolean {
    return audioReleaseController.releaseAudioForPlayback(messageId, turnId);
  }

  function stopAudioPlayback(
    turnId: string | null,
    messageId: string | null,
    reason: string,
  ): void {
    timelineController.stopAudioPlaybackForSegment(turnId, messageId, reason);
  }

  const audioSettlementController = createAdapterAudioSettlementController({
    pendingAudios: deps.state.pendingAudios,
    findOpenAudioSegments,
    rejectAudioBeforeStart,
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
    queueAudioForPlayback: audioReleaseController.queueAudioForPlayback,
    releaseQueuedAudioForTimelinePlayback,
    startSegmentJob,
    rejectAudioBeforeStart,
    rejectMotionBeforeStart,
    hasPendingAudioForTurn: audioSettlementController.hasPendingAudioForTurn,
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
