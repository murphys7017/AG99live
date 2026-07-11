import {
  matchesPlaybackGroup,
  type PendingAudioItem,
} from "../../playback-timeline/playbackReleaseQueue.js";

export interface AudioSettlementSegment {
  turnId: string | null;
  messageId: string;
}

export interface AdapterAudioSettlementControllerDeps {
  pendingAudios: Map<string, PendingAudioItem>;
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
    reason: string,
  ) => void;
  stopTimelinesForTurn: (turnId: string | null, reason: string) => void;
  stopAllTimelines: (reason: string) => void;
}

export function createAdapterAudioSettlementController(
  deps: AdapterAudioSettlementControllerDeps,
) {
  function hasPendingAudioForTurn(turnId: string | null): boolean {
    for (const item of deps.pendingAudios.values()) {
      if (matchesPlaybackGroup(item.turnId, turnId)) {
        return true;
      }
    }
    return false;
  }

  function stopAudioAndSettleTurn(
    turnId: string | null,
    reason: string,
  ): void {
    let shouldStopAudio = false;
    const activeSegment = findOpenAudioSegmentForTurn(turnId);
    if (activeSegment) {
      shouldStopAudio = true;
    }
    settlePendingAudiosForTurn(turnId, reason);
    if (shouldStopAudio) {
      deps.stopAudioPlayback(
        activeSegment?.turnId ?? null,
        activeSegment?.messageId ?? null,
        reason,
      );
    }
    deps.stopTimelinesForTurn(turnId, reason);
  }

  function stopAudioAndSettleAll(reason: string): void {
    const activeSegments = deps.findOpenAudioSegments();
    for (const [queueKey, item] of Array.from(deps.pendingAudios.entries())) {
      deps.markAudioPlaybackTerminal(
        "failed",
        item.turnId,
        reason,
        item.messageId,
      );
      deps.pendingAudios.delete(queueKey);
    }
    if (activeSegments.length === 0) {
      deps.stopAudioPlayback(null, null, reason);
      deps.stopAllTimelines(reason);
      return;
    }
    for (const activeSegment of activeSegments) {
      deps.stopAudioPlayback(activeSegment.turnId, activeSegment.messageId, reason);
    }
    deps.stopAllTimelines(reason);
  }

  function findOpenAudioSegment(): AudioSettlementSegment | null {
    return deps.findOpenAudioSegments()[0] ?? null;
  }

  function settlePendingAudiosForTurn(
    turnId: string | null,
    reason: string,
  ): void {
    for (const [queueKey, item] of Array.from(deps.pendingAudios.entries())) {
      if (!matchesTurn(item.turnId, turnId)) {
        continue;
      }
      deps.markAudioPlaybackTerminal(
        "failed",
        item.turnId,
        reason,
        item.messageId,
      );
      deps.pendingAudios.delete(queueKey);
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
