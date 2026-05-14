import type { StartAudioPlaybackOptions } from "./audioPlayback.js";
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
  matchesPlaybackGroup,
  queueAudioForPlayback as queuePendingAudioForPlayback,
  type PendingAudioItem,
} from "./playbackReleaseQueue.js";

export type AudioPlaybackTerminalState = "idle" | "completed" | "failed" | "absent";

export interface AdapterAudioRuntimeState {
  isPlayingAudio: boolean;
  currentOrchestrationId: string | null;
  statusMessage: string;
  lastError: string;
  pendingAudios: Map<string, PendingAudioItem>;
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackStartedOrchestrationId: string | null;
  audioPlaybackStartedMessageId: string | null;
  audioPlaybackStartedAtMs: number;
  audioPlaybackDurationMs: number | null;
  audioPlaybackTerminalState: AudioPlaybackTerminalState;
  audioPlaybackTerminalTurnId: string | null;
  audioPlaybackTerminalOrchestrationId: string | null;
  audioPlaybackTerminalReason: string;
}

export interface AdapterAudioRuntimeSessionStore {
  markAudioStarted: (
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
    startedAtMs?: number | null,
    durationMs?: number | null,
  ) => void;
  markAudioDuration: (
    orchestrationId: string | null,
    turnId: string | null,
    messageId: string,
    durationMs: number | null,
  ) => void;
  markAudioTerminal: (
    orchestrationId: string | null,
    turnId: string | null,
    terminal: Exclude<AudioPlaybackTerminalState, "idle">,
    messageId: string,
    reason?: string,
  ) => void;
  getSessions: () => Array<{
    segmentOrder: string[];
    segments: Map<
      string,
      {
        messageId: string;
        turnId: string | null;
        orchestrationId: string | null;
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
  startAudio: (url: string, opts: StartAudioPlaybackOptions) => Promise<void>;
  stopAudioRuntime: () => void;
  pushHistory: (role: string, text: string) => void;
  getSessionStore: () => AdapterAudioRuntimeSessionStore | undefined;
}

export interface ActiveAudioSegment {
  turnId: string | null;
  orchestrationId: string | null;
  messageId: string;
}

export interface AdapterAudioRuntime {
  queueAudioForPlayback: (
    audioUrl: string,
    turnId: string | null,
    orchestrationId: string | null,
    messageId: string,
  ) => void;
  playAudioAndAcknowledge: (
    audioUrl: string,
    turnId: string | null,
    orchestrationId: string | null,
    messageId: string,
  ) => Promise<void>;
  releaseAudioForPlayback: (
    messageId: string,
    turnId: string | null,
    orchestrationId: string | null,
  ) => boolean;
  hasPendingAudioForTurn: (turnId: string | null, orchestrationId: string | null) => boolean;
  markMissingAudiosForTurn: (
    turnId: string | null,
    orchestrationId: string | null,
    reason: string,
  ) => void;
  markAudioPlaybackTerminal: (
    terminalState: Exclude<AudioPlaybackTerminalState, "idle">,
    turnId: string | null,
    orchestrationId: string | null,
    reason?: string,
    messageId?: string | null,
  ) => void;
  resetAudioPlaybackTerminal: () => void;
  stopAudioPlayback: () => void;
  findActiveAudioSegment: () => ActiveAudioSegment | null;
}

export function createAdapterAudioRuntime(
  deps: AdapterAudioRuntimeDeps,
): AdapterAudioRuntime {
  const audioBridge = {
    get state() {
      return deps.state;
    },
    get sessionStore() {
      const sessionStore = deps.getSessionStore();
      return sessionStore
        ? {
            markAudioTerminal: (
              orchestrationId: string | null,
              turnId: string | null,
              terminal: "completed" | "failed" | "absent",
              messageId: string,
              reason?: string,
            ) => sessionStore.markAudioTerminal(orchestrationId, turnId, terminal, messageId, reason),
            getSessions: () => sessionStore.getSessions(),
          }
        : undefined;
    },
  } satisfies AudioBridgeDeps;

  const audioPlaybackCtx = {
    get state() {
      return deps.state;
    },
    startAudio: deps.startAudio,
    stopAudioRuntime: deps.stopAudioRuntime,
    pushHistory: deps.pushHistory,
    markTerminal: markAudioPlaybackTerminal,
    resetTerminal: resetAudioPlaybackTerminal,
    get sessionStore() {
      const sessionStore = deps.getSessionStore();
      return sessionStore
        ? {
            markAudioStarted: (
              orchestrationId: string | null,
              turnId: string | null,
              messageId: string,
              startedAtMs?: number | null,
              durationMs?: number | null,
            ) => sessionStore.markAudioStarted(
              orchestrationId,
              turnId,
              messageId,
              startedAtMs,
              durationMs,
            ),
            markAudioDuration: (
              orchestrationId: string | null,
              turnId: string | null,
              messageId: string,
              durationMs: number | null,
            ) => sessionStore.markAudioDuration(
              orchestrationId,
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
    orchestrationId: string | null,
    reason = "",
    messageId: string | null = null,
  ): void {
    markAudioTerminalBridge(audioBridge, terminalState, turnId, orchestrationId, reason, messageId);
  }

  function resetAudioPlaybackTerminal(): void {
    resetAudioTerminalBridge(audioBridge);
  }

  function queueAudioForPlayback(
    audioUrl: string,
    turnId: string | null,
    orchestrationId: string | null,
    messageId: string,
  ): void {
    queuePendingAudioForPlayback(
      deps.state.pendingAudios,
      audioUrl,
      turnId,
      orchestrationId,
      messageId,
    );
    deps.state.statusMessage = "收到语音回复，等待同步播放。";
    deps.pushHistory("system", deps.state.statusMessage);
  }

  async function playAudioAndAcknowledge(
    audioUrl: string,
    turnId: string | null,
    orchestrationId: string | null = deps.state.currentOrchestrationId,
    messageId: string,
  ): Promise<void> {
    return playAudioAction(audioPlaybackCtx, audioUrl, turnId, orchestrationId, messageId);
  }

  function releaseAudioForPlayback(
    messageId: string,
    turnId: string | null,
    orchestrationId: string | null,
  ): boolean {
    const item = deps.state.pendingAudios.get(messageId);
    if (!item) {
      return false;
    }
    const audioUrl = item.audioUrl.trim();
    if (!audioUrl) {
      return false;
    }
    if (!matchesPlaybackGroup(
      item.turnId,
      item.orchestrationId,
      turnId,
      orchestrationId,
    )) {
      return false;
    }
    const releasedTurnId = item.turnId ?? turnId;
    const releasedOrchestrationId = item.orchestrationId ?? orchestrationId;
    deps.state.pendingAudios.delete(messageId);
    void playAudioAndAcknowledge(
      audioUrl,
      releasedTurnId,
      releasedOrchestrationId,
      messageId,
    );
    return true;
  }

  function hasPendingAudioForTurn(
    turnId: string | null,
    orchestrationId: string | null,
  ): boolean {
    return hasPendingAudioForTurnBridge(audioBridge, turnId, orchestrationId);
  }

  function markMissingAudiosForTurn(
    turnId: string | null,
    orchestrationId: string | null,
    reason: string,
  ): void {
    markMissingAudiosForTurnBridge(audioBridge, turnId, orchestrationId, reason);
  }

  function stopAudioPlayback(): void {
    stopAudioAction(audioPlaybackCtx);
  }

  function findActiveAudioSegment(): ActiveAudioSegment | null {
    const sessions = deps.getSessionStore()?.getSessions() ?? [];
    for (const session of sessions) {
      for (const segmentId of session.segmentOrder) {
        const segment = session.segments.get(segmentId);
        if (segment?.audio.started && segment.audio.terminal === "idle") {
          return {
            turnId: segment.turnId,
            orchestrationId: segment.orchestrationId,
            messageId: segment.messageId,
          };
        }
      }
    }
    return null;
  }

  return {
    queueAudioForPlayback,
    playAudioAndAcknowledge,
    releaseAudioForPlayback,
    hasPendingAudioForTurn,
    markMissingAudiosForTurn,
    markAudioPlaybackTerminal,
    resetAudioPlaybackTerminal,
    stopAudioPlayback,
    findActiveAudioSegment,
  };
}
