import { matchesPlaybackGroup } from "../../playback-timeline/playbackReleaseQueue.js";
import {
  hasPendingAudioForTurn as hasPendingAudioForTurnBridge,
  markMissingAudiosForTurn as markMissingAudiosForTurnBridge,
  type AudioBridgeDeps,
} from "./adapterAudioBridge.js";

export interface AudioSettlementSegment {
  turnId: string | null;
  messageId: string;
}

export interface AdapterAudioSettlementControllerDeps {
  audioBridge: AudioBridgeDeps;
  findOpenAudioSegments: () => AudioSettlementSegment[];
  markAudioPlaybackTerminal: (
    terminalState: "completed" | "failed" | "absent",
    turnId: string | null,
    reason?: string,
    messageId?: string | null,
  ) => void;
  stopAudioPlayback: () => void;
}

export function createAdapterAudioSettlementController(
  deps: AdapterAudioSettlementControllerDeps,
) {
  function hasPendingAudioForTurn(turnId: string | null): boolean {
    return hasPendingAudioForTurnBridge(deps.audioBridge, turnId);
  }

  function markMissingAudiosForTurn(
    turnId: string | null,
    reason: string,
  ): void {
    markMissingAudiosForTurnBridge(deps.audioBridge, turnId, reason);
  }

  function stopAudioAndSettleTurn(
    turnId: string | null,
    reason: string,
  ): void {
    let shouldStopAudio = false;
    const activeSegment = findOpenAudioSegmentForTurn(turnId);
    if (activeSegment) {
      deps.markAudioPlaybackTerminal(
        "failed",
        activeSegment.turnId,
        reason,
        activeSegment.messageId,
      );
      shouldStopAudio = true;
    }
    settlePendingAudiosForTurn(turnId, reason);
    if (shouldStopAudio) {
      deps.stopAudioPlayback();
    }
  }

  function stopAudioAndSettleAll(reason: string): void {
    for (const activeSegment of deps.findOpenAudioSegments()) {
      deps.markAudioPlaybackTerminal(
        "failed",
        activeSegment.turnId,
        reason,
        activeSegment.messageId,
      );
    }
    for (const [queueKey, item] of Array.from(deps.audioBridge.state.pendingAudios.entries())) {
      deps.markAudioPlaybackTerminal(
        "failed",
        item.turnId,
        reason,
        item.messageId,
      );
      deps.audioBridge.state.pendingAudios.delete(queueKey);
    }
    deps.stopAudioPlayback();
  }

  function findOpenAudioSegment(): AudioSettlementSegment | null {
    return deps.findOpenAudioSegments()[0] ?? null;
  }

  function settlePendingAudiosForTurn(
    turnId: string | null,
    reason: string,
  ): void {
    for (const [queueKey, item] of Array.from(deps.audioBridge.state.pendingAudios.entries())) {
      if (!matchesTurn(item.turnId, turnId)) {
        continue;
      }
      deps.markAudioPlaybackTerminal(
        "failed",
        item.turnId,
        reason,
        item.messageId,
      );
      deps.audioBridge.state.pendingAudios.delete(queueKey);
    }
  }

  function findOpenAudioSegmentForTurn(
    turnId: string | null,
  ): AudioSettlementSegment | null {
    return deps.findOpenAudioSegments().find((segment) =>
      matchesTurn(segment.turnId, turnId)
    ) ?? null;
  }

  return {
    hasPendingAudioForTurn,
    markMissingAudiosForTurn,
    stopAudioAndSettleTurn,
    stopAudioAndSettleAll,
    findOpenAudioSegment,
  };
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
