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
  function runSettlementStep(
    step: string,
    action: () => void,
    errors: unknown[],
  ): void {
    try {
      action();
    } catch (error) {
      console.error(`[AudioSettlement] ${step} failed.`, error);
      errors.push(error);
    }
  }

  function stopAudioAndSettleTurn(
    turnId: string | null,
    reason: string,
  ): void {
    const errors: unknown[] = [];
    let activeSegment: AudioSettlementSegment | null = null;
    try {
      activeSegment = findOpenAudioSegmentForTurn(turnId);
    } catch (error) {
      console.error("[AudioSettlement] open audio lookup failed.", error);
      errors.push(error);
    }
    if (activeSegment) {
      const segment = activeSegment;
      runSettlementStep(
        `audio stop (${segment.messageId})`,
        () => deps.stopAudioPlayback(
          segment.turnId,
          segment.messageId,
          reason,
        ),
        errors,
      );
    }
    runSettlementStep(
      "turn timeline stop",
      () => deps.stopTimelinesForTurn(turnId, reason),
      errors,
    );
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  function stopAudioAndSettleAll(reason: string): void {
    const errors: unknown[] = [];
    let activeSegments: AudioSettlementSegment[] = [];
    runSettlementStep(
      "open audio enumeration",
      () => {
        activeSegments = deps.findOpenAudioSegments();
      },
      errors,
    );
    for (const activeSegment of activeSegments) {
      runSettlementStep(
        `audio stop (${activeSegment.messageId})`,
        () => deps.stopAudioPlayback(
          activeSegment.turnId,
          activeSegment.messageId,
          reason,
        ),
        errors,
      );
    }
    runSettlementStep(
      "all timeline stop",
      () => deps.stopAllTimelines(reason),
      errors,
    );
    if (errors.length > 0) {
      throw errors[0];
    }
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
