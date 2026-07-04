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
import { createPetRuntimeSnapshotPublisher } from "../desktop-bridge/usePetRuntimeSnapshotPublisher";
import { usePreviewMotionPlayer } from "../live2d-renderer/usePreviewMotionPlayer";
import { useModelEngine } from "../model-engine/useModelEngine";
import { createAudioStartMotionTimelineBridge } from "../playback-timeline/audioStartMotionBridge.js";
import { createModelEngineMotionTimelineSink } from "../playback-timeline/motionSink.js";
import { cloneModelEngineSettings } from "../model-engine/settings";
import type { ModelEngineSettings } from "../model-engine/settings";
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
import { useBilibiliLiveRuntime } from "../bilibili-live/useBilibiliLiveRuntime";
import { isTerminalPhase } from "../turn-playback/session";

export interface PetDesktopRuntime {
  sessionStore: ReturnType<typeof useTurnPlaybackSessionStore>;
  selectedModel: ReturnType<typeof createModelSync>["selectedModel"];
  motionEngineSettings: ModelEngineSettings;
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
    onMotionLabRawEvent: (payload, turnId) => {
      adapter.sendMotionLabRawEvent(cloneJson(payload), turnId);
    },
    initialMotionPlaybackRecords,
  });
  const motionTimelineRuns = new Map<string, {
    turnId: string | null;
    messageId: string;
  }>();
  const markMotionTimelineStarted = (
    event: Parameters<typeof playbackCoordinator.recordMotionPlayback>[0],
  ): void => {
    if (event.startReason === "preview") {
      return;
    }
    adapter.markMotionTimelineStarted(event.turnId, event.messageId);
    if (event.runId) {
      motionTimelineRuns.set(event.runId, {
        turnId: event.turnId,
        messageId: event.messageId,
      });
    }
  };
  const markMotionTimelineTerminal = (event: {
    runId: string;
    status: string;
    reason?: string;
  }): void => {
    const owner = motionTimelineRuns.get(event.runId);
    if (!owner) {
      return;
    }
    motionTimelineRuns.delete(event.runId);
    adapter.markMotionTimelineTerminal(
      owner.turnId,
      owner.messageId,
      event.status === "completed"
        ? "completed"
        : event.status === "stopped"
          ? "interrupted"
          : "failed",
      event.reason || event.status,
    );
  };
  const modelEngine = useModelEngine({
    getSelectedModel: () => selectedModel.value,
    getSettings: () => cloneModelEngineSettings(motionEngineSettings),
    playPlan: (plan, model, options) => motionPlayer.playPlan(plan, model, {
      ...options,
      onFinished: (event) => {
        options?.onFinished?.(event);
        markMotionTimelineTerminal(event);
        playbackCoordinator.completeMotionPlayback(event);
      },
    }),
    playCatalogMotion: (motion, model, options) => motionPlayer.playCatalogMotion(motion, model, {
      ...options,
      onFinished: (event) => {
        options?.onFinished?.(event);
        markMotionTimelineTerminal(event);
        playbackCoordinator.completeMotionPlayback(event);
      },
    }),
    stopPlan: (reason) => motionPlayer.stopPlan(reason),
    getCurrentTurnId: () => adapter.state.currentTurnId,
    pushHistory: (role, text) => adapter.pushHistory(role, text),
    getPlayerMessage: () => motionPlayer.state.message,
    onPlanStarted: (event) => {
      markMotionTimelineStarted(event);
      playbackCoordinator.recordMotionPlayback(event);
    },
    sessionStore: {
      getActiveSession: () => sessionStore.getActiveSession(),
      getSessionByTurnId: (turnId) => sessionStore.getSession(turnId),
      markMotionAbsent: (turnId, messageId) => sessionStore.markMotionAbsent(turnId, messageId),
      markMotionFailed: (turnId, messageId, reason) => sessionStore.markMotionFailed(turnId, messageId, reason),
    },
  });
  const audioStartMotionBridge = createAudioStartMotionTimelineBridge({
    schedule: (delayMs, fn) => window.setTimeout(fn, delayMs),
    clearSchedule: (timer) => window.clearTimeout(timer as number),
    canStartMotionForAudioTimeline: (turnId, messageId) => {
      const session = sessionStore.getSession(turnId);
      const segment = session?.segments.get(messageId);
      return Boolean(
        session
        && segment
        && !isTerminalPhase(session.phase)
        && segment.audio.started
        && segment.audio.terminal === "idle",
      );
    },
    getPlaybackTimelineSnapshotForSegment: adapter.getPlaybackTimelineSnapshotForSegment,
    startMotionForAudioTimeline: (turnId, messageId, playbackTimeline) =>
      modelEngine.notifyAudioPlaybackStarted(
        turnId,
        messageId,
        playbackTimeline,
      ),
  });
  adapter.setAudioTimelineStartedHandler((turnId, messageId) => {
    audioStartMotionBridge.handleAudioTimelineStarted(turnId, messageId);
  });
  adapter.setMotionPreviewHandler((payload) => {
    const localPlayed = modelEngine.playPreviewPayload(payload);
    if (!localPlayed) {
      console.warn("[AG99live] Remote motion preview playback failed to start.");
    }
    return localPlayed;
  });
  const motionTimelineSink = createModelEngineMotionTimelineSink({
    motionEngine: modelEngine,
    getPlaybackTimelineSnapshotForSegment: adapter.getPlaybackTimelineSnapshotForSegment,
    prepareMotionOnlyTimeline: adapter.prepareMotionOnlyTimeline,
    prepareMotionTimelineSink: adapter.prepareMotionTimelineSink,
    markMotionTimelineTerminal: adapter.markMotionTimelineTerminal,
  });

  useTurnPlaybackOrchestrator({
    sessionStore,
    playbackRelease: {
      releaseAssistantTextForPlayback: adapter.releaseAssistantTextForPlayback,
      releaseAudioForPlayback: adapter.releaseAudioForPlayback,
    },
    motionPayload: {
      start: motionTimelineSink.start,
      notifyCurrentTurnChanged: motionTimelineSink.notifyCurrentTurnChanged,
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
  let snapshotPublisher: ReturnType<typeof createPetRuntimeSnapshotPublisher> | null = null;
  const bilibiliLive = useBilibiliLiveRuntime({
    sendText: (text) => adapter.sendText(text),
    isInteractionBusy: () => {
      const activeSession = sessionStore.getActiveSession();
      if (adapter.state.currentTurnId) {
        return true;
      }
      return Boolean(activeSession && !isTerminalPhase(activeSession.phase));
    },
    pushHistory: (role, text) => adapter.pushHistory(role, text),
    onStatusChanged: () => {
      snapshotPublisher?.publishRuntimeSnapshot();
    },
  });

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

  snapshotPublisher = createPetRuntimeSnapshotPublisher({
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
    bilibiliLiveStatus: () => bilibiliLive.getStatus(),
  });

  const commandHandler = createDesktopRuntimeCommandHandler({
    adapter,
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
    setBilibiliLiveSettings: bilibiliLive.applySettings,
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
    bilibiliLive.start();
  });

  onBeforeUnmount(() => {
    audioStartMotionBridge.clear();
    pushToTalk.dispose();
    bilibiliLive.dispose();
    playbackCoordinator.resetPlaybackCoordination();
    motionTimelineRuns.clear();
    adapter.setAudioTimelineStartedHandler(null);
    modelEngine.stop("unmount");
    detachBridgeListener();
    detachProfileAuthoringBridgeListener();
    snapshotPublisher?.dispose();
  });

  const runtime: PetDesktopRuntime = {
    sessionStore,
    selectedModel,
    motionEngineSettings,
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
