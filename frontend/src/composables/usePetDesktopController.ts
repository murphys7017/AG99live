import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { buildParameterActionPreview } from "../action-lab/parameterActionPreview";
import { useAdapterConnection } from "./useAdapterConnection";
import { useDesktopBridge } from "./useDesktopBridge";
import { useModelSync } from "./useModelSync";
import { usePetRuntimeSnapshotPublisher } from "./usePetRuntimeSnapshotPublisher";
import { usePlaybackCompletionCoordinator } from "./usePlaybackCompletionCoordinator";
import { useTurnPlaybackOrchestrator } from "./useTurnPlaybackOrchestrator";
import { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import {
  cloneModelEngineSettings,
} from "../model-engine/settings";
import { usePreviewMotionPlayer } from "./usePreviewMotionPlayer";
import { useModelEngine } from "../model-engine/useModelEngine";
import { cloneJson } from "../utils/cloneJson";
import { applyMotionEngineSettingsSnapshot } from "./motionEngineSettingsSnapshot";
import type {
  DesktopMotionPlaybackRecord,
  DesktopProfileAuthoringCommand,
  DesktopMotionTuningSample,
  DesktopRuntimeCommand,
} from "../types/desktop";

export function usePetDesktopController() {
  const { state, selectedModel, selectedSemanticAxisProfile } = useModelSync();
  const sessionStore = useTurnPlaybackSessionStore();
  const adapter = useAdapterConnection(sessionStore);
  const bridge = useDesktopBridge();
  const motionPlayer = usePreviewMotionPlayer();
  const motionEngineSettings = reactive(
    cloneModelEngineSettings(bridge.state.snapshot.motionEngineSettings),
  );
  const initialMotionPlaybackRecords: DesktopMotionPlaybackRecord[] =
    bridge.state.snapshot.motionPlaybackRecords.map((record) =>
      cloneJson(record) as DesktopMotionPlaybackRecord);
  const ambientMotionEnabled = ref(bridge.state.snapshot.ambientMotionEnabled);
  const playbackAck = {
    sendPlaybackFinishedForCurrentGroup: adapter.sendPlaybackFinishedForCurrentGroup,
    clearPlaybackGroupContext: adapter.clearPlaybackGroupContext,
  };
  const motionRecord = {
    getLastAssistantText: () => adapter.state.lastAssistantText,
    getSelectedModel: () => selectedModel,
  };
  const playbackCoordinator = usePlaybackCompletionCoordinator({
    sessionStore,
    playbackAck,
    motionRecord,
    motionPlayer,
    onAudioPlaybackStarted: (turnId, messageId) => {
      modelEngine.notifyAudioPlaybackStarted(turnId, messageId);
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
    pushHistory: (role, text) => adapter.pushHistory(role, text),
    getPlayerMessage: () => motionPlayer.state.message,
    onPlanStarted: playbackCoordinator.recordMotionPlayback,
    sessionStore: {
      getActiveSession: () => sessionStore.getActiveSession(),
      getSessionById: (sessionId) => sessionStore.getSessionById(sessionId),
    },
  });
  useTurnPlaybackOrchestrator({
    sessionStore,
    playbackRelease: {
      releaseAssistantTextForPlayback: adapter.releaseAssistantTextForPlayback,
      releaseAudioForPlayback: adapter.releaseAudioForPlayback,
    },
    motionPayload: {
      ingestNormalizedPayload: modelEngine.ingestNormalizedPayload,
      notifyCurrentTurnChanged: modelEngine.notifyCurrentTurnChanged,
    },
  });

  applyMotionEngineSettingsSnapshot(motionEngineSettings, bridge.state.snapshot.motionEngineSettings);

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
        applyMotionEngineSettingsSnapshot(motionEngineSettings, command.settings);
        return;
      case "request_model_projection_sync":
        snapshotPublisher.publishModelProjectionSnapshot();
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

  const snapshotPublisher = usePetRuntimeSnapshotPublisher({
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
    sessionStore,
  });

  const detachBridgeListener = bridge.onCommand(handleDesktopCommand);
  const detachProfileAuthoringBridgeListener = bridge.onProfileAuthoringCommand(
    handleProfileAuthoringCommand,
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
    sessionStore,
    selectedModel,
    stageMessage,
    showContextMenu,
  };
}
