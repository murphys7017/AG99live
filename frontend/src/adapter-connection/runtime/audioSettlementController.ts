export interface AudioSettlementSegment {
  turnId: string | null;
  messageId: string;
}

export interface AdapterAudioSettlementControllerDeps {
  findOpenAudioSegments: () => AudioSettlementSegment[];
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
  function stopAudioAndSettleTurn(
    turnId: string | null,
    reason: string,
  ): void {
    const activeSegment = findOpenAudioSegmentForTurn(turnId);
    if (activeSegment) {
      deps.stopAudioPlayback(
        activeSegment.turnId,
        activeSegment.messageId,
        reason,
      );
    }
    deps.stopTimelinesForTurn(turnId, reason);
  }

  function stopAudioAndSettleAll(reason: string): void {
    const activeSegments = deps.findOpenAudioSegments();
    if (activeSegments.length === 0) {
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

  function findOpenAudioSegmentForTurn(
    turnId: string | null,
  ): AudioSettlementSegment | null {
    return deps.findOpenAudioSegments().find((segment) =>
      matchesTurn(segment.turnId, turnId)
    ) ?? null;
  }

  return {
    stopAudioAndSettleTurn,
    stopAudioAndSettleAll,
    findOpenAudioSegment,
  };
}

function matchesTurn(
  candidateTurnId: string | null,
  targetTurnId: string | null,
): boolean {
  return candidateTurnId === targetTurnId;
}
