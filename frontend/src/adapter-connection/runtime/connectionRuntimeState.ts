export interface ConnectionRuntimeState {
  isPlayingAudio: boolean;
  currentTurnId: string | null;
  serverInfo: unknown;
  activeWsAddress: string;
  micCapturing: boolean;
  assistantTextDeliveryTurnId: string | null;
  turnFinishedTurnId: string | null;
  turnFinishedSuccess: boolean;
  turnFinishedReason: string;
  latestSemanticAxisProfileSaveResult: unknown;
}

export interface ConnectionRuntimeDeps {
  state: ConnectionRuntimeState;
  stopMicrophoneCapture: (reason: string) => Promise<boolean>;
  stopAudioAndSettleAll: (reason: string) => void;
  historyAdapter: { resetHistoryState: () => void } | null;
  modelSyncAdapter: { resetModelSyncState: () => void } | null;
}

export async function resetConnectionRuntimeState(
  deps: ConnectionRuntimeDeps,
  reason: string,
): Promise<void> {
  const errors: unknown[] = [];
  const resetStep = async (
    step: string,
    action: () => void | Promise<unknown>,
  ): Promise<void> => {
    try {
      await action();
    } catch (error) {
      console.error(`[Connection] ${step} failed.`, error);
      errors.push(error);
    }
  };

  await resetStep("microphone cleanup", async () => {
    const stopped = await deps.stopMicrophoneCapture(reason);
    if (!stopped) {
      throw new Error("microphone_cleanup_failed");
    }
  });
  await resetStep("audio and timeline cleanup", () => deps.stopAudioAndSettleAll(reason));
  await resetStep("history reset", () => deps.historyAdapter?.resetHistoryState());
  await resetStep("connection state reset", () => {
    const s = deps.state;
    s.isPlayingAudio = false;
    s.currentTurnId = null;
    s.serverInfo = null;
    s.activeWsAddress = "";
    s.micCapturing = false;
    s.assistantTextDeliveryTurnId = null;
    s.turnFinishedTurnId = null;
    s.turnFinishedSuccess = true;
    s.turnFinishedReason = "";
    s.latestSemanticAxisProfileSaveResult = null;
  });
  await resetStep("model sync reset", () => deps.modelSyncAdapter?.resetModelSyncState());
  if (errors.length > 0) {
    throw errors[0];
  }
}
