export interface ConnectionRuntimeState {
  isPlayingAudio: boolean;
  currentTurnId: string | null;
  serverInfo: unknown;
  activeWsAddress: string;
  micRequested: boolean;
  micCapturing: boolean;
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackStartedMessageId: string | null;
  audioPlaybackStartedAtMs: number;
  audioPlaybackDurationMs: number | null;
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
  resetAudioPlaybackTerminal: () => void;
}

export function resetConnectionRuntimeState(deps: ConnectionRuntimeDeps): void {
  void deps.stopMicrophoneCapture("connection_closed");
  deps.stopAudioAndSettleAll("connection_closed");
  deps.historyAdapter?.resetHistoryState();
  const s = deps.state;
  s.isPlayingAudio = false;
  s.currentTurnId = null;
  s.serverInfo = null;
  s.activeWsAddress = "";
  s.micRequested = false;
  s.micCapturing = false;
  s.audioPlaybackStartedTurnId = null;
  s.audioPlaybackStartedMessageId = null;
  s.audioPlaybackStartedAtMs = 0;
  s.audioPlaybackDurationMs = null;
  deps.resetAudioPlaybackTerminal();
  s.assistantTextDeliveryTurnId = null;
  s.turnFinishedTurnId = null;
  s.turnFinishedSuccess = true;
  s.turnFinishedReason = "";
  s.latestSemanticAxisProfileSaveResult = null;
  deps.modelSyncAdapter?.resetModelSyncState();
}
