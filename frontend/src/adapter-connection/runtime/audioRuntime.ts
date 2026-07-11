import type { PlaybackTimelineAudioSink } from "../../playback-timeline/audioSink.js";
import type {
  PlaybackTimelineLipSyncRuntime,
  PlaybackTimelineLipSyncRuntimeCallbacks,
} from "../../playback-timeline/lipSyncSink.js";
import type {
  PlaybackTimelineSnapshot,
} from "../../playback-timeline/contracts.js";
import type {
  PlaybackTimelineRuntime,
} from "../../playback-timeline/playbackTimelineRuntime.js";
import {
  createAdapterAudioTimelineController,
} from "./audioTimelineController.js";
import type { PendingAudioItem } from "../../playback-timeline/playbackReleaseQueue.js";
import {
  createPlaybackTimelineAudioReleaseController,
} from "../../playback-timeline/audioReleaseController.js";
import {
  createAdapterAudioSettlementController,
} from "./audioSettlementController.js";
import type {
  PlaybackTimelineSegmentMotionSink,
  PlaybackTimelineSegmentSessionPort,
  PlaybackTimelineSegmentTextSink,
} from "../../playback-timeline/segmentJob.js";
import type { NormalizedMotionPayload } from "../../model-engine/contracts.js";

export type AudioPlaybackTerminalState = "idle" | "completed" | "failed" | "absent";

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

export interface AdapterAudioRuntimeSessionStore {
  markAudioReleased: (
    turnId: string | null,
    messageId: string,
  ) => void;
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
    terminal: Exclude<AudioPlaybackTerminalState, "idle">,
    messageId: string,
    reason?: string,
  ) => void;
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

export interface AdapterAudioRuntimeDeps {
  state: AdapterAudioRuntimeState;
  audioSink: PlaybackTimelineAudioSink;
  pushHistory: (role: string, text: string) => void;
  getSessionStore: () => AdapterAudioRuntimeSessionStore | undefined;
  createLipSyncRuntime?: (
    callbacks: PlaybackTimelineLipSyncRuntimeCallbacks,
  ) => PlaybackTimelineLipSyncRuntime;
  onAudioTimelineStarted?: (
    turnId: string | null,
    messageId: string,
    playbackTimeline: PlaybackTimelineSnapshot | null,
  ) => void;
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
  releaseAudioForPlayback: (
    messageId: string,
    turnId: string | null,
  ) => boolean;
  configureSegmentExecution: (options: {
    session: PlaybackTimelineSegmentSessionPort;
    textSink: PlaybackTimelineSegmentTextSink;
    motionSink: Pick<
      PlaybackTimelineSegmentMotionSink<NormalizedMotionPayload>,
      "start" | "interrupt"
    >;
  }) => void;
  startSegmentJob: PlaybackTimelineRuntime<NormalizedMotionPayload>["startSegmentJob"];
  hasPendingAudioForTurn: (turnId: string | null) => boolean;
  markAudioPlaybackTerminal: (
    terminalState: Exclude<AudioPlaybackTerminalState, "idle">,
    turnId: string | null,
    reason?: string,
    messageId?: string | null,
  ) => void;
  resetAudioPlaybackTerminal: () => void;
  stopAudioAndSettleTurn: (turnId: string | null, reason: string) => void;
  stopAudioAndSettleAll: (reason: string) => void;
  findActiveAudioSegment: () => ActiveAudioSegment | null;
  findOpenAudioSegment: () => ActiveAudioSegment | null;
  getPlaybackTimelineSnapshotForSegment: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineSnapshot | null;
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
    pushHistory: deps.pushHistory,
    getAudioSession: () => {
      const sessionStore = deps.getSessionStore();
      return sessionStore
        ? {
            markAudioStarted: sessionStore.markAudioStarted,
            markAudioDuration: sessionStore.markAudioDuration,
            markAudioTerminal: sessionStore.markAudioTerminal,
          }
        : undefined;
    },
    getMotionSession: () => {
      const sessionStore = deps.getSessionStore();
      return sessionStore
        ? {
            markMotionStarted: sessionStore.markMotionStarted,
            markMotionCompleted: sessionStore.markMotionCompleted,
            markMotionFailed: sessionStore.markMotionFailed,
          }
        : undefined;
    },
    createLipSyncRuntime: deps.createLipSyncRuntime,
    onAudioTimelineStarted: deps.onAudioTimelineStarted,
    markTerminal: markAudioPlaybackTerminalState,
    resetTerminal: resetAudioPlaybackTerminal,
  });
  const { playbackTimelineRuntime } = timelineController;
  const {
    startSegmentJob,
    markMotionTimelineStarted,
    markMotionTimelineTerminal,
    findActiveAudioTimelineSegments,
    findOpenAudioTimelineSegments,
    getTimelineSnapshotForSegment: getPlaybackTimelineSnapshotForSegment,
  } = playbackTimelineRuntime;

  function markAudioPlaybackTerminal(
    terminalState: Exclude<AudioPlaybackTerminalState, "idle">,
    turnId: string | null,
    reason = "",
    messageId: string | null = null,
  ): void {
    deps.state.audioPlaybackTerminalState = terminalState;
    deps.state.audioPlaybackTerminalTurnId = turnId;
    deps.state.audioPlaybackTerminalReason = reason;

    if (!messageId) {
      return;
    }
    deps.getSessionStore()?.markAudioTerminal(
      turnId,
      terminalState,
      messageId,
      reason,
    );
  }

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

  function releaseAudioForPlayback(
    messageId: string,
    turnId: string | null,
  ): boolean {
    const released = releaseQueuedAudioForTimelinePlayback(messageId, turnId);
    if (released) {
      deps.getSessionStore()?.markAudioReleased(turnId, messageId);
    }
    return released;
  }

  function configureSegmentExecution(options: {
    session: PlaybackTimelineSegmentSessionPort;
    textSink: PlaybackTimelineSegmentTextSink;
    motionSink: Pick<
      PlaybackTimelineSegmentMotionSink<NormalizedMotionPayload>,
      "start" | "interrupt"
    >;
  }): void {
    playbackTimelineRuntime.configureSegmentExecution({
      session: options.session,
      textSink: options.textSink,
      audioSink: {
        releaseAudioForPlayback: releaseQueuedAudioForTimelinePlayback,
      },
      motionSink: {
        start: options.motionSink.start,
        interrupt: options.motionSink.interrupt,
      },
    });
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
    markAudioPlaybackTerminal,
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

  return {
    queueAudioForPlayback: audioReleaseController.queueAudioForPlayback,
    releaseAudioForPlayback,
    configureSegmentExecution,
    startSegmentJob,
    hasPendingAudioForTurn: audioSettlementController.hasPendingAudioForTurn,
    markAudioPlaybackTerminal,
    resetAudioPlaybackTerminal,
    stopAudioAndSettleTurn: audioSettlementController.stopAudioAndSettleTurn,
    stopAudioAndSettleAll: audioSettlementController.stopAudioAndSettleAll,
    findActiveAudioSegment,
    findOpenAudioSegment: audioSettlementController.findOpenAudioSegment,
    getPlaybackTimelineSnapshotForSegment,
    markMotionTimelineStarted,
    markMotionTimelineTerminal,
  };
}
