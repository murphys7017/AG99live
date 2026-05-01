<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import DesktopPetCanvas from "../components/DesktopPetCanvas.vue";
import { buildParameterActionPreview } from "../action-lab/parameterActionPreview";
import { useAdapterConnection } from "../composables/useAdapterConnection";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import { useModelSync } from "../composables/useModelSync";
import {
  cloneModelEngineSettings,
  modelEngineSettingsEqual,
  normalizeModelEngineSettings,
} from "../model-engine/settings";
import { usePreviewMotionPlayer } from "../composables/usePreviewMotionPlayer";
import { useModelEngine } from "../model-engine/useModelEngine";
import type {
  DesktopMotionPlaybackRecord,
  DesktopProfileAuthoringCommand,
  DesktopMotionTuningSample,
  DesktopRuntimeCommand,
} from "../types/desktop";
import type { ModelEnginePlanStartedEvent } from "../model-engine/contracts";

const { state, selectedModel, selectedSemanticAxisProfile } = useModelSync();
const adapter = useAdapterConnection();
const bridge = useDesktopBridge();
const motionPlayer = usePreviewMotionPlayer();
const MAX_MOTION_PLAYBACK_RECORDS = 5;
const PLAYBACK_SETTLEMENT_WINDOW_MS = 900;
const motionEngineSettings = reactive(
  cloneModelEngineSettings(bridge.state.snapshot.motionEngineSettings),
);
const motionPlaybackRecords = ref<DesktopMotionPlaybackRecord[]>(
  bridge.state.snapshot.motionPlaybackRecords.map((record) =>
    cloneJson(record) as DesktopMotionPlaybackRecord),
);
const modelEngine = useModelEngine({
  getSelectedModel: () => selectedModel.value,
  getSettings: () => cloneModelEngineSettings(motionEngineSettings),
  playPlan: (plan, model, options) => motionPlayer.playPlan(plan, model, options),
  stopPlan: (reason) => motionPlayer.stopPlan(reason),
  getCurrentTurnId: () => adapter.state.currentTurnId,
  getCurrentOrchestrationId: () => adapter.state.currentOrchestrationId,
  getAudioPlaybackInfo: () => ({
    turnId: adapter.state.audioPlaybackStartedTurnId,
    orchestrationId: adapter.state.audioPlaybackStartedOrchestrationId,
    startedAtMs: adapter.state.audioPlaybackStartedAtMs,
    durationMs: adapter.state.audioPlaybackDurationMs,
  }),
  pushHistory: (role, text) => adapter.pushHistory(role, text),
  getPlayerMessage: () => motionPlayer.state.message,
  onPlanStarted: (event) => recordMotionPlayback(event),
});
const ambientMotionEnabled = ref(bridge.state.snapshot.ambientMotionEnabled);
const playbackCoordination = reactive({
  activeTurnId: null as string | null,
  activeOrchestrationId: null as string | null,
  textDelivered: false,
  audioObserved: false,
  audioCompleted: false,
  audioFailed: false,
  motionStarted: false,
  motionCompleted: false,
  motionExpected: false,
  awaitingLateMotion: false,
  turnFinishedObserved: false,
  turnFinishedSuccess: true,
  completionSent: false,
  settlementTimer: 0,
});

function applyMotionEngineSettingsSnapshot(nextValue: unknown): void {
  const normalized = normalizeModelEngineSettings(nextValue);
  const currentSettings = cloneModelEngineSettings(motionEngineSettings);
  if (modelEngineSettingsEqual(currentSettings, normalized)) {
    return;
  }
  motionEngineSettings.motionIntensityScale = normalized.motionIntensityScale;
  motionEngineSettings.axisIntensityScale = {
    ...normalized.axisIntensityScale,
  };
}

applyMotionEngineSettingsSnapshot(bridge.state.snapshot.motionEngineSettings);

const connectionState = computed(() => {
  if (adapter.state.status === "connecting") {
    return "connecting";
  }
  if (adapter.state.status === "error") {
    return "error";
  }
  if (selectedModel.value) {
    return "synced";
  }
  if (adapter.state.status === "connected") {
    return "linked";
  }
  return "disconnected";
});

const connectionLabel = computed(() => {
  if (connectionState.value === "synced") {
    return "已同步模型";
  }
  if (connectionState.value === "connecting") {
    return "连接中";
  }
  if (connectionState.value === "error") {
    return "连接异常";
  }
  if (connectionState.value === "linked") {
    return "已连接适配器";
  }
  return "未连接";
});

const stageMessage = computed(() => {
  if (adapter.state.lastAssistantText.trim()) {
    return adapter.state.lastAssistantText.trim();
  }
  if (adapter.state.lastError.trim()) {
    return adapter.state.lastError.trim();
  }
  if (selectedModel.value) {
    return `${selectedModel.value.name} 已进入桌宠待命状态。`;
  }
  return adapter.state.statusMessage;
});

const aiState = computed(() => {
  if (adapter.state.status === "connecting") {
    return "connecting";
  }
  if (adapter.state.status === "error") {
    return "error";
  }
  if (adapter.state.currentTurnId && adapter.state.isPlayingAudio) {
    return "speaking";
  }
  if (adapter.state.currentTurnId) {
    return "thinking";
  }
  if (adapter.state.micCapturing) {
    return "listening";
  }
  if (adapter.state.status === "connected" || selectedModel.value) {
    return "idle";
  }
  return "offline";
});

const parameterActionPreview = computed(() =>
  buildParameterActionPreview(
    selectedModel.value?.parameter_action_library,
    state.modelInfo?.runtime_cache_errors,
  ),
);

function handlePreviewMotionPlan(plan: unknown): void {
  const localPlayed = modelEngine.playPreviewPayload(plan);
  if (!localPlayed) {
    console.warn("[AG99live] Local motion preview playback failed to start.");
  }
  adapter.sendMotionPayloadPreview(plan);
}

function clearPlaybackSettlementTimer(): void {
  if (playbackCoordination.settlementTimer) {
    window.clearTimeout(playbackCoordination.settlementTimer);
    playbackCoordination.settlementTimer = 0;
  }
}

function resetPlaybackCoordination(): void {
  clearPlaybackSettlementTimer();
  playbackCoordination.activeTurnId = null;
  playbackCoordination.activeOrchestrationId = null;
  playbackCoordination.textDelivered = false;
  playbackCoordination.audioObserved = false;
  playbackCoordination.audioCompleted = false;
  playbackCoordination.audioFailed = false;
  playbackCoordination.motionStarted = false;
  playbackCoordination.motionCompleted = false;
  playbackCoordination.motionExpected = false;
  playbackCoordination.awaitingLateMotion = false;
  playbackCoordination.turnFinishedObserved = false;
  playbackCoordination.turnFinishedSuccess = true;
  playbackCoordination.completionSent = false;
}

function ensurePlaybackCoordination(
  turnId: string | null,
  orchestrationId: string | null,
): void {
  const turnChanged = playbackCoordination.activeTurnId !== turnId;
  const orchestrationChanged =
    playbackCoordination.activeOrchestrationId !== orchestrationId;
  if (turnChanged || orchestrationChanged) {
    resetPlaybackCoordination();
    playbackCoordination.activeTurnId = turnId;
    playbackCoordination.activeOrchestrationId = orchestrationId;
  }
}

function shouldSendPlaybackFinished(): boolean {
  if (playbackCoordination.completionSent) {
    return false;
  }
  if (!playbackCoordination.textDelivered) {
    return false;
  }
  if (!playbackCoordination.audioObserved) {
    return false;
  }
  if (!playbackCoordination.audioCompleted && !playbackCoordination.audioFailed) {
    return false;
  }
  if (playbackCoordination.awaitingLateMotion) {
    return false;
  }
  if (!playbackCoordination.motionExpected) {
    return true;
  }
  if (!playbackCoordination.motionStarted) {
    return false;
  }
  return playbackCoordination.motionCompleted;
}

function isPlaybackAckRequired(): boolean {
  const terminalState = adapter.state.audioPlaybackTerminalState;
  return terminalState === "completed" || terminalState === "failed";
}

function finalizePlaybackCoordination(): void {
  const turnId = playbackCoordination.activeTurnId;
  const orchestrationId = playbackCoordination.activeOrchestrationId;
  adapter.clearPlaybackGroupContext(turnId, orchestrationId);
  resetPlaybackCoordination();
}

function maybeFlushPlaybackCompletion(reason?: string): void {
  if (!shouldSendPlaybackFinished()) {
    return;
  }
  if (!isPlaybackAckRequired()) {
    if (playbackCoordination.turnFinishedObserved) {
      finalizePlaybackCoordination();
    }
    return;
  }
  if (!playbackCoordination.completionSent) {
    const turnId = playbackCoordination.activeTurnId;
    const orchestrationId = playbackCoordination.activeOrchestrationId;
    const success = !playbackCoordination.audioFailed;
    playbackCoordination.completionSent = true;
    void adapter.sendPlaybackFinishedForCurrentGroup(
      turnId,
      orchestrationId,
      success,
      reason,
    );
    return;
  }
  if (playbackCoordination.turnFinishedObserved) {
    finalizePlaybackCoordination();
  }
}

function schedulePlaybackSettlementWindow(): void {
  clearPlaybackSettlementTimer();
  playbackCoordination.awaitingLateMotion = true;
  playbackCoordination.settlementTimer = window.setTimeout(() => {
    playbackCoordination.awaitingLateMotion = false;
    if (!playbackCoordination.motionStarted) {
      playbackCoordination.motionExpected = false;
    }
    maybeFlushPlaybackCompletion("audio_and_motion_settled");
  }, PLAYBACK_SETTLEMENT_WINDOW_MS);
}

function recordMotionPlayback(event: ModelEnginePlanStartedEvent): void {
  ensurePlaybackCoordination(event.turnId, event.orchestrationId);
  playbackCoordination.motionExpected = true;
  playbackCoordination.motionStarted = true;
  playbackCoordination.motionCompleted = false;
  playbackCoordination.awaitingLateMotion = false;
  clearPlaybackSettlementTimer();
  const now = new Date();
  const record: DesktopMotionPlaybackRecord = {
    id: `motion-record-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now.toISOString(),
    source: event.diagnostics?.source || event.startReason,
    payloadKind: event.payloadKind,
    turnId: event.turnId,
    orchestrationId: event.orchestrationId,
    modelName: event.model?.name ?? selectedModel.value?.name ?? "",
    emotionLabel: event.plan.emotion_label,
    mode: event.plan.mode,
    startReason: event.startReason,
    queuedDelayMs: event.queuedDelayMs,
    assistantText: adapter.state.lastAssistantText,
    playerMessage: event.playerMessage,
    diagnostics: event.diagnostics
      ? {
        ...event.diagnostics,
        axisIntensityScale: { ...event.diagnostics.axisIntensityScale },
      }
      : null,
    plan: cloneJson(event.plan),
  };
  motionPlaybackRecords.value = [
    record,
    ...motionPlaybackRecords.value,
  ].slice(0, MAX_MOTION_PLAYBACK_RECORDS);
}

function saveMotionTuningSample(sample: DesktopMotionTuningSample): void {
  adapter.saveMotionTuningSample(cloneJson(sample));
}

function deleteMotionTuningSample(sampleId: string): void {
  adapter.deleteMotionTuningSample(sampleId);
}

function cloneJson<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}

function serializeAxisIntensityScale(axisIntensityScale: Record<string, number>): string {
  return JSON.stringify(
    Object.entries(axisIntensityScale).sort(([left], [right]) =>
      left.localeCompare(right)),
  );
}

function applyAmbientMotionPreference(attemptsRemaining = 12): void {
  const live2dAdapter = window.getLAppAdapter?.();
  if (live2dAdapter?.setAmbientMotionEnabled) {
    live2dAdapter.setAmbientMotionEnabled(ambientMotionEnabled.value);
    return;
  }

  if (attemptsRemaining <= 0) {
    return;
  }

  window.setTimeout(() => {
    applyAmbientMotionPreference(attemptsRemaining - 1);
  }, 120);
}

function handleDesktopCommand(command: DesktopRuntimeCommand): void {
  switch (command.type) {
    case "set_address":
      adapter.setAddress(command.address);
      return;
    case "set_desktop_screenshot_on_send":
      adapter.setDesktopScreenshotOnSendEnabled(command.enabled);
      return;
    case "set_ambient_motion_enabled":
      ambientMotionEnabled.value = command.enabled;
      applyAmbientMotionPreference();
      return;
    case "set_motion_engine_settings":
      applyMotionEngineSettingsSnapshot(command.settings);
      return;
    case "request_motion_tuning_samples_sync":
      bridge.publishMotionTuningSamples(
        adapter.state.motionTuningSamples,
        adapter.state.motionTuningSamplesStatus,
      );
      return;
    case "save_motion_tuning_sample":
      saveMotionTuningSample(command.sample);
      return;
    case "delete_motion_tuning_sample":
      deleteMotionTuningSample(command.sampleId);
      return;
    case "request_history_list":
      adapter.requestHistoryList();
      return;
    case "create_history":
      adapter.createHistory();
      return;
    case "load_history":
      adapter.loadHistory(command.historyUid);
      return;
    case "delete_history":
      adapter.deleteHistory(command.historyUid);
      return;
    case "connect":
      if (typeof command.address === "string") {
        adapter.setAddress(command.address);
      }
      adapter.connect();
      return;
    case "disconnect":
      adapter.disconnect();
      return;
    case "send_text":
      void adapter.sendText(command.text);
      return;
    case "interrupt":
      modelEngine.stop("interrupted");
      adapter.interruptCurrentTurn();
      return;
    case "toggle_mic_capture":
      void adapter.toggleMicrophoneCapture();
      return;
    case "preview_motion_plan":
      handlePreviewMotionPlan(command.plan);
      return;
    case "preview_motion_payload":
      handlePreviewMotionPlan(command.payload);
      return;
  }
}

function handleProfileAuthoringCommand(
  command: DesktopProfileAuthoringCommand,
): void {
  if (command.type !== "save_semantic_axis_profile") {
    return;
  }

  adapter.sendSemanticAxisProfileSave({
    request_id: command.requestId,
    model_name: command.modelName,
    profile_id: command.profileId,
    expected_revision: command.expectedRevision,
    profile: cloneJson(command.profile),
  });
}

function showContextMenu(event: MouseEvent): void {
  window.ag99desktop?.showContextMenu({
    x: event.clientX,
    y: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
  });
}

const detachBridgeListener = bridge.onCommand(handleDesktopCommand);
const detachProfileAuthoringBridgeListener = bridge.onProfileAuthoringCommand(
  handleProfileAuthoringCommand,
);

watch(
  () => adapter.state.inboundMotionPlanNonce,
  () => {
    console.info("[PetDesktopView] inboundMotionPlanNonce watch fired. nonce=", adapter.state.inboundMotionPlanNonce);
    const plan = adapter.state.inboundMotionPlan;
    if (!plan) {
      console.warn("[PetDesktopView] inboundMotionPlan is null, skipping.");
      return;
    }
    modelEngine.ingestInboundPayload(plan, {
      turnId: adapter.state.inboundMotionPlanTurnId,
      orchestrationId: adapter.state.inboundMotionPlanOrchestrationId,
      receivedAtMs: adapter.state.inboundMotionPlanReceivedAtMs,
    });
  },
);

watch(
  () => adapter.state.audioPlaybackStartedNonce,
  () => {
    ensurePlaybackCoordination(
      adapter.state.audioPlaybackStartedTurnId,
      adapter.state.audioPlaybackStartedOrchestrationId,
    );
    playbackCoordination.audioObserved = true;
    playbackCoordination.audioFailed = false;
    playbackCoordination.audioCompleted = false;
    modelEngine.notifyAudioPlaybackStarted(adapter.state.audioPlaybackStartedTurnId);
  },
);

watch(
  () => adapter.state.assistantTextDeliveryNonce,
  () => {
    ensurePlaybackCoordination(
      adapter.state.assistantTextDeliveryTurnId,
      adapter.state.assistantTextDeliveryOrchestrationId,
    );
    playbackCoordination.textDelivered = true;
    maybeFlushPlaybackCompletion("text_audio_motion_completed");
  },
);

watch(
  () => adapter.state.audioPlaybackTerminalNonce,
  () => {
    ensurePlaybackCoordination(
      adapter.state.audioPlaybackTerminalTurnId,
      adapter.state.audioPlaybackTerminalOrchestrationId,
    );
    const terminalState = adapter.state.audioPlaybackTerminalState;
    if (terminalState === "idle") {
      return;
    }
    playbackCoordination.audioObserved = true;
    playbackCoordination.audioCompleted =
      terminalState === "completed" || terminalState === "not_requested";
    playbackCoordination.audioFailed = terminalState === "failed";
    if (!playbackCoordination.motionStarted || playbackCoordination.motionCompleted) {
      schedulePlaybackSettlementWindow();
      return;
    }
    maybeFlushPlaybackCompletion(adapter.state.audioPlaybackTerminalReason || "audio_terminal");
  },
);

watch(
  () => motionPlayer.state.status,
  (status, previousStatus) => {
    if (status !== "finished") {
      return;
    }
    if (previousStatus !== "playing") {
      return;
    }
    playbackCoordination.motionCompleted = true;
    if (playbackCoordination.audioObserved) {
      maybeFlushPlaybackCompletion("motion_completed_after_audio");
    }
  },
);

watch(
  () => adapter.state.turnFinishedNonce,
  () => {
    ensurePlaybackCoordination(
      adapter.state.turnFinishedTurnId,
      adapter.state.turnFinishedOrchestrationId,
    );
    playbackCoordination.turnFinishedObserved = true;
    playbackCoordination.turnFinishedSuccess = adapter.state.turnFinishedSuccess;
    maybeFlushPlaybackCompletion(adapter.state.turnFinishedReason || "turn_finished");
  },
);

watch(
  () => adapter.state.currentTurnId,
  (turnId) => {
    modelEngine.notifyCurrentTurnChanged(turnId);
  },
);

watch(
  () => ({
    samples: adapter.state.motionTuningSamples,
    status: adapter.state.motionTuningSamplesStatus,
  }),
  ({ samples, status }) => {
    bridge.publishMotionTuningSamples(samples, status);
  },
  { deep: true, immediate: true },
);

watch(
  () => [
    ambientMotionEnabled.value,
    adapter.state.address,
    adapter.state.desktopScreenshotOnSendEnabled,
    adapter.state.status,
    adapter.state.statusMessage,
    adapter.state.sessionId,
    adapter.state.serverInfo?.ws_url ?? "",
    adapter.state.serverInfo?.http_base_url ?? "",
    adapter.state.lastAssistantText,
    adapter.state.lastTranscription,
    adapter.state.lastImageCount,
    adapter.state.currentTurnId,
    adapter.state.micRequested,
    adapter.state.micCapturing,
    adapter.state.isPlayingAudio,
    adapter.state.historyEntries,
    adapter.state.backendHistorySummaries,
    adapter.state.backendHistoryEntries,
    adapter.state.activeBackendHistoryUid,
    adapter.state.backendHistoryLoading,
    adapter.state.backendHistoryStatusMessage,
    state.confName,
    state.lastUpdated,
    selectedModel.value?.name ?? "",
    selectedModel.value?.icon_url ?? "",
    selectedModel.value?.engine_hints.recommended_mode ?? "",
    parameterActionPreview.value,
    stageMessage.value,
    motionEngineSettings.motionIntensityScale,
    serializeAxisIntensityScale(motionEngineSettings.axisIntensityScale),
    motionPlaybackRecords.value,
    selectedSemanticAxisProfile.value,
  ],
  () => {
    bridge.publishSnapshot({
      adapterAddress: adapter.state.address,
      desktopScreenshotOnSendEnabled: adapter.state.desktopScreenshotOnSendEnabled,
      ambientMotionEnabled: ambientMotionEnabled.value,
      motionEngineSettings: cloneModelEngineSettings(motionEngineSettings),
      motionPlaybackRecords: motionPlaybackRecords.value.map((record) =>
        cloneJson(record)),
      connectionState: connectionState.value,
      connectionLabel: connectionLabel.value,
      connectionStatusMessage: adapter.state.statusMessage,
      aiState: aiState.value,
      micRequested: adapter.state.micRequested,
      micCapturing: adapter.state.micCapturing,
      audioPlaying: adapter.state.isPlayingAudio,
      sessionId: adapter.state.sessionId || state.sessionId,
      confName: state.confName,
      lastUpdated: state.lastUpdated,
      selectedModelName: selectedModel.value?.name ?? "",
      selectedModelIconUrl: selectedModel.value?.icon_url ?? "",
      recommendedMode:
        selectedModel.value?.engine_hints.recommended_mode ?? "",
      serverWsUrl: adapter.state.serverInfo?.ws_url ?? "",
      httpBaseUrl: adapter.state.serverInfo?.http_base_url ?? "",
      stageMessage: stageMessage.value,
      lastSentText: adapter.state.historyEntries
        .slice()
        .reverse()
        .find((entry) => entry.role === "user")?.text ?? "",
      lastAssistantText: adapter.state.lastAssistantText,
      lastTranscription: adapter.state.lastTranscription,
      lastImageCount: adapter.state.lastImageCount,
      historyEntries: [...adapter.state.historyEntries],
      backendHistorySummaries: adapter.state.backendHistorySummaries.map((summary) =>
        cloneJson(summary)),
      backendHistoryEntries: adapter.state.backendHistoryEntries.map((entry) =>
        cloneJson(entry)),
      activeBackendHistoryUid: adapter.state.activeBackendHistoryUid,
      backendHistoryLoading: adapter.state.backendHistoryLoading,
      backendHistoryStatusMessage: adapter.state.backendHistoryStatusMessage,
      runtimeSemanticAxisProfile: selectedSemanticAxisProfile.value
        ? cloneJson(selectedSemanticAxisProfile.value)
        : null,
      baseActionPreview: parameterActionPreview.value,
    });
  },
  { deep: true, immediate: true },
);

watch(
  () => adapter.state.latestSemanticAxisProfileSaveResult,
  () => {
    bridge.publishProfileAuthoringSnapshot({
      latestSemanticAxisProfileSaveResult: adapter.state.latestSemanticAxisProfileSaveResult
        ? cloneJson(adapter.state.latestSemanticAxisProfileSaveResult)
        : null,
    });
  },
  { deep: true, immediate: true },
);

watch(
  () => [selectedModel.value?.model_url ?? "", ambientMotionEnabled.value],
  () => {
    applyAmbientMotionPreference();
  },
  { immediate: true },
);

onMounted(async () => {
  await adapter.initialize();
  adapter.connect();
  applyAmbientMotionPreference();
});

onBeforeUnmount(() => {
  resetPlaybackCoordination();
  modelEngine.stop("unmount");
  detachBridgeListener();
  detachProfileAuthoringBridgeListener();
});
</script>

<template>
  <main
    class="desktop-shell desktop-shell--pet"
    @contextmenu.prevent="showContextMenu"
  >
    <DesktopPetCanvas
      :selected-model="selectedModel"
      :stage-message="stageMessage"
    />
  </main>
</template>
