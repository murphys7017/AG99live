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

export function resetConnectionRuntimeState(
  deps: ConnectionRuntimeDeps,
  reason: string,
): void {
  void deps.stopMicrophoneCapture(reason).catch((error) => {
    console.error("[Connection] microphone cleanup failed unexpectedly.", error);
  });
  deps.stopAudioAndSettleAll(reason);
  deps.historyAdapter?.resetHistoryState();
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
  deps.modelSyncAdapter?.resetModelSyncState();
}
