import { matchesPlaybackGroup } from "../../playback-timeline/playbackReleaseQueue.js";
import {
  hasPendingAudioForTurn as hasPendingAudioForTurnBridge,
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
  stopAudioPlayback: (
    turnId: string | null,
    messageId: string | null,
  ) => void;
}

export function createAdapterAudioSettlementController(
  deps: AdapterAudioSettlementControllerDeps,
) {
  function hasPendingAudioForTurn(turnId: string | null): boolean {
    return hasPendingAudioForTurnBridge(deps.audioBridge, turnId);
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
      deps.stopAudioPlayback(
        activeSegment?.turnId ?? null,
        activeSegment?.messageId ?? null,
      );
    }
  }

  function stopAudioAndSettleAll(reason: string): void {
    const activeSegments = deps.findOpenAudioSegments();
    for (const activeSegment of activeSegments) {
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
    if (activeSegments.length === 0) {
      deps.stopAudioPlayback(null, null);
      return;
    }
    for (const activeSegment of activeSegments) {
      deps.stopAudioPlayback(activeSegment.turnId, activeSegment.messageId);
    }
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
