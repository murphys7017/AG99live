import { matchesPlaybackGroup, type PendingAudioItem } from "./playbackReleaseQueue.js";

export interface AudioBridgeState {
  audioPlaybackTerminalState: "idle" | "completed" | "failed" | "absent";
  audioPlaybackTerminalTurnId: string | null;
  audioPlaybackTerminalOrchestrationId: string | null;
  audioPlaybackTerminalReason: string;
  pendingAudios: Map<string, PendingAudioItem>;
}

export interface AudioBridgeSessionStore {
  markAudioTerminal: (
    orchestrationId: string | null,
    turnId: string | null,
    terminal: "completed" | "failed" | "absent",
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
        audio: { terminal: string };
      }
    >;
  }>;
}

export interface AudioBridgeDeps {
  state: AudioBridgeState;
  sessionStore?: AudioBridgeSessionStore;
}

export function markAudioPlaybackTerminal(
  deps: AudioBridgeDeps,
  terminalState: "completed" | "failed" | "absent",
  turnId: string | null,
  orchestrationId: string | null,
  reason = "",
  messageId: string | null = null,
): void {
  deps.state.audioPlaybackTerminalState = terminalState;
  deps.state.audioPlaybackTerminalTurnId = turnId;
  deps.state.audioPlaybackTerminalOrchestrationId = orchestrationId;
  deps.state.audioPlaybackTerminalReason = reason;

  if (!messageId) {
    return;
  }

  deps.sessionStore?.markAudioTerminal(
    orchestrationId,
    turnId,
    terminalState,
    messageId,
    reason,
  );
}

export function resetAudioPlaybackTerminal(deps: AudioBridgeDeps): void {
  deps.state.audioPlaybackTerminalState = "idle";
  deps.state.audioPlaybackTerminalTurnId = null;
  deps.state.audioPlaybackTerminalOrchestrationId = null;
  deps.state.audioPlaybackTerminalReason = "";
}

export function hasPendingAudioForTurn(
  deps: AudioBridgeDeps,
  turnId: string | null,
  orchestrationId: string | null,
): boolean {
  for (const item of deps.state.pendingAudios.values()) {
    if (matchesPlaybackGroup(item.turnId, item.orchestrationId, turnId, orchestrationId)) {
      return true;
    }
  }
  return false;
}

export function markMissingAudiosForTurn(
  deps: AudioBridgeDeps,
  turnId: string | null,
  orchestrationId: string | null,
  reason: string,
): void {
  const sessions = deps.sessionStore?.getSessions() ?? [];
  for (const session of sessions) {
    for (const segmentId of session.segmentOrder) {
      const segment = session.segments.get(segmentId);
      if (
        segment
        && segment.audio.terminal === "idle"
        && !deps.state.pendingAudios.has(segment.messageId)
        && matchesPlaybackGroup(segment.turnId, segment.orchestrationId, turnId, orchestrationId)
      ) {
        markAudioPlaybackTerminal(
          deps,
          "absent",
          segment.turnId,
          segment.orchestrationId,
          reason,
          segment.messageId,
        );
      }
    }
  }
}
