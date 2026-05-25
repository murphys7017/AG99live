import {
  computed,
  inject,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  type ComputedRef,
  type InjectionKey,
} from "vue";
import { buildParameterActionPreview } from "../action-lab/parameterActionPreview";
import { useAdapterConnection } from "../adapter-connection/useAdapterConnection";
import { createModelSync, useModelSync } from "../adapter-connection/model-sync/useModelSync";
import { useDesktopBridge } from "../desktop-bridge/useDesktopBridge";
import { usePetRuntimeSnapshotPublisher } from "../desktop-bridge/usePetRuntimeSnapshotPublisher";
import { usePreviewMotionPlayer } from "../live2d-renderer/usePreviewMotionPlayer";
import { useModelEngine } from "../model-engine/useModelEngine";
import { cloneModelEngineSettings } from "../model-engine/settings";
import { usePlaybackCompletionCoordinator } from "../turn-playback/usePlaybackCompletionCoordinator";
import { useTurnPlaybackOrchestrator } from "../turn-playback/useTurnPlaybackOrchestrator";
import { useTurnPlaybackSessionStore } from "../turn-playback/useTurnPlaybackSessionStore";
import type {
  DesktopMotionPlaybackRecord,
  DesktopMotionTuningSample,
} from "../types/desktop";
import { cloneJson } from "../utils/cloneJson";
import { applyMotionEngineSettingsSnapshot } from "./motionEngineSettingsSnapshot";
import { useAmbientMotionPreference } from "./useAmbientMotionPreference";
import { useDesktopContextMenu } from "./useDesktopContextMenu";
import { createDesktopRuntimeCommandHandler } from "../desktop-bridge/useDesktopRuntimeCommandHandler";
import { usePushToTalkController } from "./usePushToTalkController";

export interface PetDesktopRuntime {
  sessionStore: ReturnType<typeof useTurnPlaybackSessionStore>;
  selectedModel: ReturnType<typeof createModelSync>["selectedModel"];
  stageMessage: ComputedRef<string>;
  showContextMenu: ReturnType<typeof useDesktopContextMenu>["showContextMenu"];
}

export const petDesktopRuntimeKey: InjectionKey<PetDesktopRuntime> =
  Symbol("AG99livePetDesktopRuntime");

export function providePetDesktopRuntime(): PetDesktopRuntime {
  const sessionStore = useTurnPlaybackSessionStore();
  const modelSync = useModelSync(createModelSync());
  const { state, selectedModel, selectedSemanticAxisProfile } = modelSync;
  const adapter = useAdapterConnection(sessionStore, modelSync);
  const bridge = useDesktopBridge();
  const motionPlayer = usePreviewMotionPlayer();
  const motionEngineSettings = reactive(
    cloneModelEngineSettings(bridge.state.snapshot.motionEngineSettings),
  );
  const initialMotionPlaybackRecords: DesktopMotionPlaybackRecord[] =
    bridge.state.snapshot.motionPlaybackRecords.map((record) =>
      cloneJson(record) as DesktopMotionPlaybackRecord);
  const ambientMotionEnabled = ref(bridge.state.snapshot.ambientMotionEnabled);
  const { showContextMenu } = useDesktopContextMenu();
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
    pushHistory: (role, text) => adapter.pushHistory(role, text),
    getPlayerMessage: () => motionPlayer.state.message,
    onPlanStarted: playbackCoordinator.recordMotionPlayback,
    sessionStore: {
      getActiveSession: () => sessionStore.getActiveSession(),
      getSessionByTurnId: (turnId) => sessionStore.getSession(turnId),
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
  const { applyAmbientMotionPreference } = useAmbientMotionPreference(
    ambientMotionEnabled,
    {
      getModelUrl: () => selectedModel.value?.model_url ?? "",
    },
  );
  const pushToTalk = usePushToTalkController(adapter);

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

  const commandHandler = createDesktopRuntimeCommandHandler({
    adapter,
    bridge,
    ambientMotionEnabled,
    motionEngineSettings,
    modelEngine: {
      stop: (reason) => modelEngine.stop(reason),
      playPreviewPayload: (plan) => modelEngine.playPreviewPayload(plan),
    },
    snapshotPublisher,
    saveMotionTuningSample,
    deleteMotionTuningSample,
    handlePreviewMotionPlan,
    applyAmbientMotionPreference,
  });

  const detachBridgeListener = bridge.onCommand(commandHandler.handleCommand);
  const detachProfileAuthoringBridgeListener = bridge.onProfileAuthoringCommand(
    commandHandler.handleProfileAuthoringCommand,
  );

  onMounted(async () => {
    await adapter.initialize();
    adapter.connect();
    applyAmbientMotionPreference();
    pushToTalk.install();
  });

  onBeforeUnmount(() => {
    pushToTalk.dispose();
    playbackCoordinator.resetPlaybackCoordination();
    modelEngine.stop("unmount");
    detachBridgeListener();
    detachProfileAuthoringBridgeListener();
  });

  const runtime: PetDesktopRuntime = {
    sessionStore,
    selectedModel,
    stageMessage,
    showContextMenu,
  };

  provide(petDesktopRuntimeKey, runtime);

  return runtime;
}

export function usePetDesktopRuntime(): PetDesktopRuntime {
  const runtime = inject(petDesktopRuntimeKey, null);
  if (!runtime) {
    throw new Error("[PetDesktopRuntime] no runtime instance was provided.");
  }
  return runtime;
}
