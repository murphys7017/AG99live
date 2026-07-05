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
  hasPendingAudioForTurn as hasPendingAudioForTurnBridge,
  markAudioPlaybackTerminal as markAudioTerminalBridge,
  markMissingAudiosForTurn as markMissingAudiosForTurnBridge,
  resetAudioPlaybackTerminal as resetAudioTerminalBridge,
  type AudioBridgeDeps,
} from "./adapterAudioBridge.js";
import {
  matchesPlaybackGroup,
  type PendingAudioItem,
} from "../../playback-timeline/playbackReleaseQueue.js";
import {
  createAdapterAudioQueueController,
} from "./audioQueueController.js";

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
  playAudioAndAcknowledge: (
    audioUrl: string,
    turnId: string | null,
    messageId: string,
  ) => Promise<void>;
  releaseAudioForPlayback: (
    messageId: string,
    turnId: string | null,
  ) => boolean;
  setSegmentExecutionPorts: ReturnType<typeof createPlaybackTimelineRuntime>["setSegmentExecutionPorts"];
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
    setSegmentExecutionPorts,
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

  async function playAudioAndAcknowledge(
    audioUrl: string,
    turnId: string | null,
    messageId: string,
  ): Promise<void> {
    return timelineController.playAudioAndAcknowledge(audioUrl, turnId, messageId);
  }

  const audioQueueController = createAdapterAudioQueueController({
    state: deps.state,
    startAudioPlayback: (audioUrl, turnId, messageId) => {
      void playAudioAndAcknowledge(
        audioUrl,
        turnId,
        messageId,
      );
    },
    pushHistory: deps.pushHistory,
  });

  function hasPendingAudioForTurn(turnId: string | null): boolean {
    return hasPendingAudioForTurnBridge(audioBridge, turnId);
  }

  function markMissingAudiosForTurn(
    turnId: string | null,
    reason: string,
  ): void {
    markMissingAudiosForTurnBridge(audioBridge, turnId, reason);
  }

  function stopAudioPlayback(): void {
    timelineController.stopAudioPlayback();
  }

  function matchesTurn(
    candidateTurnId: string | null,
    targetTurnId: string | null,
  ): boolean {
    if (matchesPlaybackGroup(candidateTurnId, targetTurnId)) {
      return true;
    }
    return !candidateTurnId && !targetTurnId;
  }

  function settlePendingAudiosForTurn(
    turnId: string | null,
    reason: string,
  ): void {
    for (const [queueKey, item] of Array.from(deps.state.pendingAudios.entries())) {
      if (!matchesTurn(item.turnId, turnId)) {
        continue;
      }
      markAudioPlaybackTerminal(
        "failed",
        item.turnId,
        reason,
        item.messageId,
      );
      deps.state.pendingAudios.delete(queueKey);
    }
  }

  function stopAudioAndSettleTurn(turnId: string | null, reason: string): void {
    let shouldStopAudio = false;
    const activeSegment = findActiveAudioSegmentForTurn(turnId);
    if (activeSegment) {
      markAudioPlaybackTerminal(
        "failed",
        activeSegment.turnId,
        reason,
        activeSegment.messageId,
      );
      shouldStopAudio = true;
    }
    settlePendingAudiosForTurn(turnId, reason);
    if (shouldStopAudio) {
      stopAudioPlayback();
    }
  }

  function stopAudioAndSettleAll(reason: string): void {
    for (const activeSegment of findOpenAudioSegments()) {
      markAudioPlaybackTerminal(
        "failed",
        activeSegment.turnId,
        reason,
        activeSegment.messageId,
      );
    }
    for (const [queueKey, item] of Array.from(deps.state.pendingAudios.entries())) {
      markAudioPlaybackTerminal(
        "failed",
        item.turnId,
        reason,
        item.messageId,
      );
      deps.state.pendingAudios.delete(queueKey);
    }
    stopAudioPlayback();
  }

  function findActiveAudioSegment(): ActiveAudioSegment | null {
    return findActiveAudioSegments()[0] ?? null;
  }

  function findOpenAudioSegment(): ActiveAudioSegment | null {
    return findOpenAudioSegments()[0] ?? null;
  }

  function findActiveAudioSegmentForTurn(turnId: string | null): ActiveAudioSegment | null {
    return findOpenAudioSegments().find((segment) =>
      matchesTurn(segment.turnId, turnId)
    ) ?? null;
  }

  function findActiveAudioSegments(): ActiveAudioSegment[] {
    return findActiveAudioTimelineSegments();
  }

  function findOpenAudioSegments(): ActiveAudioSegment[] {
    return findOpenAudioTimelineSegments();
  }

  return {
    queueAudioForPlayback: audioQueueController.queueAudioForPlayback,
    playAudioAndAcknowledge,
    releaseAudioForPlayback: audioQueueController.releaseAudioForPlayback,
    setSegmentExecutionPorts,
    startSegmentJob,
    prepareSegmentJob,
    hasPendingAudioForTurn,
    markMissingAudiosForTurn,
    markAudioPlaybackTerminal,
    resetAudioPlaybackTerminal,
    stopAudioAndSettleTurn,
    stopAudioAndSettleAll,
    findActiveAudioSegment,
    findOpenAudioSegment,
    getPlaybackTimelineSnapshotForSegment,
    prepareMotionOnlyTimeline,
    prepareMotionTimelineSink,
    markMotionTimelineStarted,
    markMotionTimelineTerminal,
  };
}
