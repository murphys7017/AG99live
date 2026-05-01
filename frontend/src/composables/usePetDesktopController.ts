import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { buildParameterActionPreview } from "../action-lab/parameterActionPreview";
import { useAdapterConnection } from "./useAdapterConnection";
import { useDesktopBridge } from "./useDesktopBridge";
import { useModelSync } from "./useModelSync";
import { usePetRuntimeSnapshotPublisher } from "./usePetRuntimeSnapshotPublisher";
import { usePlaybackCompletionCoordinator } from "./usePlaybackCompletionCoordinator";
import {
  cloneModelEngineSettings,
  modelEngineSettingsEqual,
  normalizeModelEngineSettings,
} from "../model-engine/settings";
import { usePreviewMotionPlayer } from "./usePreviewMotionPlayer";
import { useModelEngine } from "../model-engine/useModelEngine";
import { cloneJson } from "../utils/cloneJson";
import type {
  DesktopMotionPlaybackRecord,
  DesktopProfileAuthoringCommand,
  DesktopMotionTuningSample,
  DesktopRuntimeCommand,
} from "../types/desktop";

export function usePetDesktopController() {
  const { state, selectedModel, selectedSemanticAxisProfile } = useModelSync();
  const adapter = useAdapterConnection();
  const bridge = useDesktopBridge();
  const motionPlayer = usePreviewMotionPlayer();
  const motionEngineSettings = reactive(
    cloneModelEngineSettings(bridge.state.snapshot.motionEngineSettings),
  );
  const initialMotionPlaybackRecords: DesktopMotionPlaybackRecord[] =
    bridge.state.snapshot.motionPlaybackRecords.map((record) =>
      cloneJson(record) as DesktopMotionPlaybackRecord);
  const ambientMotionEnabled = ref(bridge.state.snapshot.ambientMotionEnabled);
  const playbackCoordinator = usePlaybackCompletionCoordinator({
    adapter,
    motionPlayer,
    selectedModel,
    onAudioPlaybackStarted: (turnId) => {
      modelEngine.notifyAudioPlaybackStarted(turnId);
    },
    initialMotionPlaybackRecords,
  });
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
    onPlanStarted: playbackCoordinator.recordMotionPlayback,
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

  function handlePreviewMotionPlan(plan: unknown): void {
    const localPlayed = modelEngine.playPreviewPayload(plan);
    if (!localPlayed) {
      console.warn("[AG99live] Local motion preview playback failed to start.");
    }
    adapter.sendMotionPayloadPreview(plan);
  }

  function saveMotionTuningSample(sample: DesktopMotionTuningSample): void {
    adapter.saveMotionTuningSample(cloneJson(sample));
  }

  function deleteMotionTuningSample(sampleId: string): void {
    adapter.deleteMotionTuningSample(sampleId);
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

  const detachBridgeListener = bridge.onCommand(handleDesktopCommand);
  const detachProfileAuthoringBridgeListener = bridge.onProfileAuthoringCommand(
    handleProfileAuthoringCommand,
  );

  watch(
    () => adapter.state.inboundMotionPlanNonce,
    () => {
      const plan = adapter.state.inboundMotionPlan;
      if (!plan) {
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
    () => adapter.state.currentTurnId,
    (turnId) => {
      modelEngine.notifyCurrentTurnChanged(turnId);
    },
  );

  usePetRuntimeSnapshotPublisher({
    adapter,
    bridge,
    modelSyncState: state,
    selectedModel,
    selectedSemanticAxisProfile,
    ambientMotionEnabled,
    motionEngineSettings,
    motionPlaybackRecords: playbackCoordinator.motionPlaybackRecords,
    parameterActionPreview,
    connectionState,
    connectionLabel,
    stageMessage,
    aiState,
  });

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
    playbackCoordinator.resetPlaybackCoordination();
    modelEngine.stop("unmount");
    detachBridgeListener();
    detachProfileAuthoringBridgeListener();
  });

  function showContextMenu(event: MouseEvent): void {
    window.ag99desktop?.showContextMenu({
      x: event.clientX,
      y: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
    });
  }

  return {
    selectedModel,
    stageMessage,
    showContextMenu,
  };
}
