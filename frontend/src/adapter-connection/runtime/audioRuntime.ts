import type { PlaybackTimelineAudioSink } from "../../playback-timeline/audioSink.js";
import type {
  PlaybackTimelineSnapshot,
} from "../../playback-timeline/contracts.js";
import {
  createPlaybackTimelineEngine,
  type PlaybackTimelineEngine,
} from "../../playback-timeline/playbackTimelineEngine.js";
import {
  playAudioAndAcknowledge as playAudioAction,
  stopAudioPlayback as stopAudioAction,
} from "./audioPlaybackActions.js";
import {
  hasPendingAudioForTurn as hasPendingAudioForTurnBridge,
  markAudioPlaybackTerminal as markAudioTerminalBridge,
  markMissingAudiosForTurn as markMissingAudiosForTurnBridge,
  resetAudioPlaybackTerminal as resetAudioTerminalBridge,
  type AudioBridgeDeps,
} from "./adapterAudioBridge.js";
import {
  getPendingPlaybackItem,
  deletePendingPlaybackItem,
  matchesPlaybackGroup,
  queueAudioForPlayback as queuePendingAudioForPlayback,
  type PendingAudioItem,
} from "./playbackReleaseQueue.js";

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
  getActiveAudioTimelineSnapshot: () => PlaybackTimelineSnapshot | null;
}

const AUDIO_TIMELINE_SINK_ID = "audio";
const LIP_SYNC_TIMELINE_SINK_ID = "lip_sync";

export function createAdapterAudioRuntime(
  deps: AdapterAudioRuntimeDeps,
): AdapterAudioRuntime {
  let activeAudioTimeline: {
    turnId: string | null;
    messageId: string;
    engine: PlaybackTimelineEngine;
  } | null = null;

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

  const audioPlaybackCtx = {
    get state() {
      return deps.state;
    },
    audioSink: deps.audioSink,
    prepareAudioTimeline,
    markAudioTimelineDuration,
    markAudioTimelineStarted,
    markLipSyncTimelineStarted,
    markLipSyncTimelineTerminal,
    markAudioTimelineTerminal,
    stopActiveAudioTimeline,
    pushHistory: deps.pushHistory,
    markTerminal: markAudioPlaybackTerminal,
    resetTerminal: resetAudioPlaybackTerminal,
    get sessionStore() {
      const sessionStore = deps.getSessionStore();
      return sessionStore
        ? {
            markAudioStarted: (
              turnId: string | null,
              messageId: string,
              startedAtMs?: number | null,
              durationMs?: number | null,
            ) => sessionStore.markAudioStarted(
              turnId,
              messageId,
              startedAtMs,
              durationMs,
            ),
            markAudioDuration: (
              turnId: string | null,
              messageId: string,
              durationMs: number | null,
            ) => sessionStore.markAudioDuration(
              turnId,
              messageId,
              durationMs,
            ),
          }
        : undefined;
    },
  };

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

  function isActiveAudioTimeline(
    turnId: string | null,
    messageId: string,
  ): boolean {
    return Boolean(
      activeAudioTimeline
      && activeAudioTimeline.messageId === messageId
      && (
        matchesTurn(activeAudioTimeline.turnId, turnId)
        || (!activeAudioTimeline.turnId && !turnId)
      ),
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
    activeAudioTimeline = {
      turnId,
      messageId,
      engine,
    };
  }

  function markAudioTimelineDuration(
    turnId: string | null,
    messageId: string,
    durationMs: number | null,
  ): void {
    if (!isActiveAudioTimeline(turnId, messageId)) {
      return;
    }
    activeAudioTimeline?.engine.setExpectedDurationMs(durationMs);
  }

  function markAudioTimelineStarted(
    turnId: string | null,
    messageId: string,
    startedAtMs: number,
    durationMs: number | null,
  ): void {
    if (!isActiveAudioTimeline(turnId, messageId) || !activeAudioTimeline) {
      return;
    }
    const engine = activeAudioTimeline.engine;
    engine.setExpectedDurationMs(durationMs);
    const audioClock = deps.audioSink.getClock();
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
    if (!isActiveAudioTimeline(turnId, messageId) || !activeAudioTimeline) {
      return;
    }
    activeAudioTimeline.engine.markSinkStarted(LIP_SYNC_TIMELINE_SINK_ID);
  }

  function markLipSyncTimelineTerminal(
    turnId: string | null,
    messageId: string,
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ): void {
    if (!isActiveAudioTimeline(turnId, messageId) || !activeAudioTimeline) {
      return;
    }
    activeAudioTimeline.engine.markSinkTerminal(
      LIP_SYNC_TIMELINE_SINK_ID,
      terminal,
      reason,
    );
  }

  function markAudioTimelineTerminal(
    turnId: string | null,
    messageId: string,
    terminal: "completed" | "failed" | "interrupted",
    reason: string,
  ): void {
    if (!isActiveAudioTimeline(turnId, messageId) || !activeAudioTimeline) {
      return;
    }
    const engine = activeAudioTimeline.engine;
    if (terminal === "interrupted") {
      engine.interrupt(reason);
    } else {
      engine.detachAudioClock();
      engine.markSinkTerminal(AUDIO_TIMELINE_SINK_ID, terminal, reason);
    }
    activeAudioTimeline = null;
  }

  function stopActiveAudioTimeline(reason: string): void {
    if (!activeAudioTimeline) {
      return;
    }
    activeAudioTimeline.engine.interrupt(reason);
    activeAudioTimeline = null;
  }

  function queueAudioForPlayback(
    audioUrl: string,
    turnId: string | null,
    messageId: string,
  ): void {
    queuePendingAudioForPlayback(
      deps.state.pendingAudios,
      audioUrl,
      turnId,
      messageId,
    );
    deps.state.statusMessage = "收到语音回复，等待同步播放。";
    deps.pushHistory("system", deps.state.statusMessage);
  }

  async function playAudioAndAcknowledge(
    audioUrl: string,
    turnId: string | null,
    messageId: string,
  ): Promise<void> {
    return playAudioAction(audioPlaybackCtx, audioUrl, turnId, messageId);
  }

  function releaseAudioForPlayback(
    messageId: string,
    turnId: string | null,
  ): boolean {
    const item = getPendingPlaybackItem(
      deps.state.pendingAudios,
      turnId,
      messageId,
    );
    if (!item) {
      return false;
    }
    const audioUrl = item.audioUrl.trim();
    if (!audioUrl) {
      return false;
    }
    if (!matchesPlaybackGroup(item.turnId, turnId)) {
      return false;
    }
    const releasedTurnId = item.turnId ?? turnId;
    deletePendingPlaybackItem(deps.state.pendingAudios, turnId, messageId);
    void playAudioAndAcknowledge(
      audioUrl,
      releasedTurnId,
      messageId,
    );
    return true;
  }

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
    stopAudioAction(audioPlaybackCtx);
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
    const activeMessageId = deps.state.audioPlaybackStartedMessageId;
    if (
      activeMessageId
      && matchesTurn(deps.state.audioPlaybackStartedTurnId, turnId)
    ) {
      markAudioPlaybackTerminal(
        "failed",
        deps.state.audioPlaybackStartedTurnId,
        reason,
        activeMessageId,
      );
      shouldStopAudio = true;
    } else {
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
    }
    settlePendingAudiosForTurn(turnId, reason);
    if (shouldStopAudio) {
      stopAudioPlayback();
    }
  }

  function stopAudioAndSettleAll(reason: string): void {
    const activeMessageId = deps.state.audioPlaybackStartedMessageId;
    if (activeMessageId) {
      markAudioPlaybackTerminal(
        "failed",
        deps.state.audioPlaybackStartedTurnId,
        reason,
        activeMessageId,
      );
    }
    for (const activeSegment of findActiveAudioSegments()) {
      if (
        activeMessageId
        && activeSegment.messageId === activeMessageId
        && matchesTurn(activeSegment.turnId, deps.state.audioPlaybackStartedTurnId)
      ) {
        continue;
      }
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

  function getActiveAudioTimelineSnapshot(): PlaybackTimelineSnapshot | null {
    return activeAudioTimeline?.engine.getSnapshot() ?? null;
  }

  function findActiveAudioSegmentForTurn(turnId: string | null): ActiveAudioSegment | null {
    return findActiveAudioSegments().find((segment) =>
      matchesTurn(segment.turnId, turnId)
    ) ?? null;
  }

  function findActiveAudioSegments(): ActiveAudioSegment[] {
    const activeSegments: ActiveAudioSegment[] = [];
    const sessions = deps.getSessionStore()?.getSessions() ?? [];
    for (const session of sessions) {
      if ("phase" in session && (
        session.phase === "completed"
        || session.phase === "failed"
      )) {
        continue;
      }
      for (const segmentId of session.segmentOrder) {
        const segment = session.segments.get(segmentId);
        if (segment?.audio.started && segment.audio.terminal === "idle") {
          activeSegments.push({
            turnId: segment.turnId,
            messageId: segment.messageId,
          });
        }
      }
    }
    return activeSegments;
  }

  return {
    queueAudioForPlayback,
    playAudioAndAcknowledge,
    releaseAudioForPlayback,
    hasPendingAudioForTurn,
    markMissingAudiosForTurn,
    markAudioPlaybackTerminal,
    resetAudioPlaybackTerminal,
    stopAudioAndSettleTurn,
    stopAudioAndSettleAll,
    findActiveAudioSegment,
    getActiveAudioTimelineSnapshot,
  };
}
