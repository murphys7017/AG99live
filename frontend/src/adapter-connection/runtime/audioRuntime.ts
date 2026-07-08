import type { PlaybackTimelineAudioSink } from "../../playback-timeline/audioSink.js";
import type {
  PlaybackTimelineLipSyncRuntime,
  PlaybackTimelineLipSyncRuntimeCallbacks,
} from "../../playback-timeline/lipSyncSink.js";
import type {
  PlaybackTimelineSnapshot,
} from "../../playback-timeline/contracts.js";
import type {
  createPlaybackTimelineRuntime,
} from "../../playback-timeline/playbackTimelineRuntime.js";
import {
  createAdapterAudioTimelineController,
} from "./audioTimelineController.js";
import {
  markAudioPlaybackTerminal as markAudioTerminalBridge,
  resetAudioPlaybackTerminal as resetAudioTerminalBridge,
  type AudioBridgeDeps,
} from "./adapterAudioBridge.js";
import type { PendingAudioItem } from "../../playback-timeline/playbackReleaseQueue.js";
import {
  createPlaybackTimelineAudioReleaseController,
} from "../../playback-timeline/audioReleaseController.js";
import {
  createAdapterAudioSettlementController,
} from "./audioSettlementController.js";

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
  getSessions: () => Array<{
    phase?: string;
    segmentOrder: string[];
    segments: Map<
      string,
      {
        messageId: string;
        turnId: string | null;
        audio: {
          url: string | null;
          released: boolean;
          started: boolean;
          terminal: string;
        };
      }
    >;
  }>;
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
  setSegmentSinks: ReturnType<typeof createPlaybackTimelineRuntime>["setSegmentSinks"];
  startSegmentJob: ReturnType<typeof createPlaybackTimelineRuntime>["startSegmentJob"];
  prepareSegmentJob: ReturnType<typeof createPlaybackTimelineRuntime>["prepareSegmentJob"];
  hasPendingAudioForTurn: (turnId: string | null) => boolean;
  markMissingAudiosForTurn: (
    turnId: string | null,
    reason: string,
  ) => void;
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
  prepareMotionOnlyTimeline: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineSnapshot | null;
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
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ) => void;
}

export function createAdapterAudioRuntime(
  deps: AdapterAudioRuntimeDeps,
): AdapterAudioRuntime {
  const timelineController = createAdapterAudioTimelineController({
    state: deps.state,
    audioSink: deps.audioSink,
    pushHistory: deps.pushHistory,
    getSessionStore: () => {
      const sessionStore = deps.getSessionStore();
      return sessionStore
        ? {
            markAudioReleased: sessionStore.markAudioReleased,
            markAudioStarted: sessionStore.markAudioStarted,
            markAudioDuration: sessionStore.markAudioDuration,
          }
        : undefined;
    },
    createLipSyncRuntime: deps.createLipSyncRuntime,
    onAudioTimelineStarted: deps.onAudioTimelineStarted,
    markTerminal: markAudioPlaybackTerminal,
    resetTerminal: resetAudioPlaybackTerminal,
  });
  const { playbackTimelineRuntime } = timelineController;
  const {
    setSegmentSinks,
    startSegmentJob,
    prepareSegmentJob,
    prepareMotionOnlyTimeline,
    prepareMotionTimelineSink,
    markMotionTimelineStarted,
    markMotionTimelineTerminal,
    findActiveAudioTimelineSegments,
    findOpenAudioTimelineSegments,
    getTimelineSnapshotForSegment: getPlaybackTimelineSnapshotForSegment,
  } = playbackTimelineRuntime;

  const audioBridge = {
    get state() {
      return deps.state;
    },
    get sessionStore() {
      const sessionStore = deps.getSessionStore();
      return sessionStore
        ? {
            markAudioTerminal: (
              turnId: string | null,
              terminal: "completed" | "failed" | "absent",
              messageId: string,
              reason?: string,
            ) => sessionStore.markAudioTerminal(turnId, terminal, messageId, reason),
            getSessions: () => sessionStore.getSessions(),
          }
        : undefined;
    },
  } satisfies AudioBridgeDeps;

  function markAudioPlaybackTerminal(
    terminalState: Exclude<AudioPlaybackTerminalState, "idle">,
    turnId: string | null,
    reason = "",
    messageId: string | null = null,
  ): void {
    markAudioTerminalBridge(audioBridge, terminalState, turnId, reason, messageId);
  }

  function resetAudioPlaybackTerminal(): void {
    resetAudioTerminalBridge(audioBridge);
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

  function stopAudioPlayback(
    turnId: string | null,
    messageId: string | null,
  ): void {
    timelineController.stopAudioPlaybackForSegment(turnId, messageId);
  }

  const audioSettlementController = createAdapterAudioSettlementController({
    audioBridge,
    findOpenAudioSegments,
    markAudioPlaybackTerminal,
    stopAudioPlayback,
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
    releaseAudioForPlayback: audioReleaseController.releaseAudioForPlayback,
    setSegmentSinks,
    startSegmentJob,
    prepareSegmentJob,
    hasPendingAudioForTurn: audioSettlementController.hasPendingAudioForTurn,
    markMissingAudiosForTurn: audioSettlementController.markMissingAudiosForTurn,
    markAudioPlaybackTerminal,
    resetAudioPlaybackTerminal,
    stopAudioAndSettleTurn: audioSettlementController.stopAudioAndSettleTurn,
    stopAudioAndSettleAll: audioSettlementController.stopAudioAndSettleAll,
    findActiveAudioSegment,
    findOpenAudioSegment: audioSettlementController.findOpenAudioSegment,
    getPlaybackTimelineSnapshotForSegment,
    prepareMotionOnlyTimeline,
    prepareMotionTimelineSink,
    markMotionTimelineStarted,
    markMotionTimelineTerminal,
  };
}
