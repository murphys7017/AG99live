export interface ConnectionRuntimeState {
  isPlayingAudio: boolean;
  currentTurnId: string | null;
  currentOrchestrationId: string | null;
  serverInfo: unknown;
  activeWsAddress: string;
  sessionId: string;
  micRequested: boolean;
  micCapturing: boolean;
  inboundMotionPlan: unknown;
  inboundMotionPlanTurnId: string | null;
  inboundMotionPlanOrchestrationId: string | null;
  inboundMotionPlanReceivedAtMs: number;
  pendingAssistantTexts: { clear(): void };
  pendingAudios: { clear(): void };
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackStartedOrchestrationId: string | null;
  audioPlaybackStartedMessageId: string | null;
  audioPlaybackStartedAtMs: number;
  audioPlaybackDurationMs: number | null;
  assistantTextDeliveryTurnId: string | null;
  assistantTextDeliveryOrchestrationId: string | null;
  turnFinishedTurnId: string | null;
  turnFinishedOrchestrationId: string | null;
  turnFinishedSuccess: boolean;
  turnFinishedReason: string;
  latestSemanticAxisProfileSaveResult: unknown;
}

export interface ConnectionRuntimeDeps {
  state: ConnectionRuntimeState;
  stopMicrophoneCapture: (reason: string) => Promise<boolean>;
  stopAudioPlayback: () => void;
  historyAdapter: { resetHistoryState: () => void } | null;
  modelSyncAdapter: { resetModelSyncState: () => void } | null;
  resetAudioPlaybackTerminal: () => void;
}

export function resetConnectionRuntimeState(deps: ConnectionRuntimeDeps): void {
  void deps.stopMicrophoneCapture("connection_closed");
  deps.stopAudioPlayback();
  deps.historyAdapter?.resetHistoryState();
  const s = deps.state;
  s.isPlayingAudio = false;
  s.currentTurnId = null;
  s.currentOrchestrationId = null;
  s.serverInfo = null;
  s.activeWsAddress = "";
  s.sessionId = "";
  s.micRequested = false;
  s.micCapturing = false;
  s.inboundMotionPlan = null;
  s.inboundMotionPlanTurnId = null;
  s.inboundMotionPlanOrchestrationId = null;
  s.inboundMotionPlanReceivedAtMs = 0;
  s.pendingAssistantTexts.clear();
  s.pendingAudios.clear();
  s.audioPlaybackStartedTurnId = null;
  s.audioPlaybackStartedOrchestrationId = null;
  s.audioPlaybackStartedMessageId = null;
  s.audioPlaybackStartedAtMs = 0;
  s.audioPlaybackDurationMs = null;
  deps.resetAudioPlaybackTerminal();
  s.assistantTextDeliveryTurnId = null;
  s.assistantTextDeliveryOrchestrationId = null;
  s.turnFinishedTurnId = null;
  s.turnFinishedOrchestrationId = null;
  s.turnFinishedSuccess = true;
  s.turnFinishedReason = "";
  s.latestSemanticAxisProfileSaveResult = null;
  deps.modelSyncAdapter?.resetModelSyncState();
}
