import {
  computed,
  inject,
  onBeforeUnmount,
  onMounted,
  provide,
  reactive,
  ref,
  watch,
  type ComputedRef,
  type InjectionKey,
} from "vue";
import { buildParameterActionPreview } from "../action-lab/parameterActionPreview";
import { useAdapterConnection } from "../adapter-connection/useAdapterConnection";
import { createModelSync, useModelSync } from "../adapter-connection/model-sync/useModelSync";
import { useDesktopBridge } from "../desktop-bridge/useDesktopBridge";
import { createPetRuntimeSnapshotPublisher } from "../desktop-bridge/usePetRuntimeSnapshotPublisher";
import { usePreviewMotionPlayer } from "../live2d-renderer/usePreviewMotionPlayer";
import {
  cloneLive2dPresentationSettings,
  type Live2dPresentationSettings,
} from "../live2d-renderer/settings";
import { useModelEngine } from "../model-engine/useModelEngine";
import { normalizeMotionPayload } from "../model-engine/normalize";
import {
  applyModelEngineSettings,
  cloneModelEngineSettings,
} from "../model-engine/settings";
import type { ModelEngineSettings } from "../model-engine/settings";
import { usePlaybackCompletionCoordinator } from "../turn-playback/usePlaybackCompletionCoordinator";
import { useMotionPlaybackRecorder } from "../playback-integrations/useMotionPlaybackRecorder";
import { useTurnPlaybackOrchestrator } from "../turn-playback/useTurnPlaybackOrchestrator";
import { useTurnPlaybackSessionStore } from "../turn-playback/useTurnPlaybackSessionStore";
import type {
  DesktopMotionPreviewStatus,
  DesktopMotionPlaybackRecord,
  DesktopMotionTuningSample,
} from "../types/desktop";
import type { DirectParameterPlanTerminalEvent } from "../types/live2d-runtime.d.ts";
import { cloneJson } from "../utils/cloneJson";
import {
  configurePlaybackTimelineMotionRuntime,
  createAppPlaybackTimelineRuntime,
  createPlaybackTimelineMotionRunTracker,
  type PlaybackTimelineWiringPort,
} from "./playbackTimelineWiring";
import { useDesktopContextMenu } from "./useDesktopContextMenu";
import { createDesktopRuntimeCommandHandler } from "../desktop-bridge/useDesktopRuntimeCommandHandler";
import { usePushToTalkController } from "./usePushToTalkController";
import { useBilibiliLiveRuntime } from "../bilibili-live/useBilibiliLiveRuntime";
import { isTerminalPhase } from "../turn-playback/session";
import {
  createIndexedDbMotionLabPendingEventStore,
  createMotionLabOutboundQueue,
  type MotionLabRawEventInput,
} from "../motion-lab/outboundQueue";
import type {
  PlaybackTimelineSegmentMotionSink,
} from "../playback-timeline/segmentJob";
import { createBrowserAudioTimelineSink } from "../playback-timeline/audioSink";
import type { NormalizedMotionPayload } from "../playback-integrations/motionPayload";

export interface PetDesktopRuntime {
  sessionStore: ReturnType<typeof useTurnPlaybackSessionStore>;
  selectedModel: ReturnType<typeof createModelSync>["selectedModel"];
  motionEngineSettings: ModelEngineSettings;
  live2dPresentationSettings: Live2dPresentationSettings;
  stageMessage: ComputedRef<string>;
  showContextMenu: ReturnType<typeof useDesktopContextMenu>["showContextMenu"];
}

export const petDesktopRuntimeKey: InjectionKey<PetDesktopRuntime> =
  Symbol("AG99livePetDesktopRuntime");

export function providePetDesktopRuntime(): PetDesktopRuntime {
  const sessionStore = useTurnPlaybackSessionStore();
  const modelSync = useModelSync(createModelSync());
  const { state, selectedModel, selectedSemanticAxisProfile } = modelSync;
  let motionTimelineSinkTarget: PlaybackTimelineSegmentMotionSink<NormalizedMotionPayload> | null = null;
  const requiredMotionTimelineSink: PlaybackTimelineSegmentMotionSink<NormalizedMotionPayload> = {
    start(payload, context) {
      if (!motionTimelineSinkTarget) {
        throw new Error("ModelEngine motion timeline sink is not initialized.");
      }
      return motionTimelineSinkTarget.start(payload, context);
    },
    interrupt(turnId, messageId, reason) {
      if (!motionTimelineSinkTarget) {
        throw new Error("ModelEngine motion timeline sink is not initialized.");
      }
      motionTimelineSinkTarget.interrupt(turnId, messageId, reason);
    },
  };
  const adapter = useAdapterConnection(
    sessionStore,
    modelSync,
    normalizeMotionPayload,
  );
  const playbackTimeline: PlaybackTimelineWiringPort =
    createAppPlaybackTimelineRuntime({
      sessionStore,
      adapterPlayback: adapter.playback,
      motionSink: requiredMotionTimelineSink,
      audioSink: createBrowserAudioTimelineSink(),
    });
  const bridge = useDesktopBridge();
  const motionPlayer = usePreviewMotionPlayer();
  const motionEngineSettings = reactive(
    cloneModelEngineSettings(bridge.state.snapshot.motionEngineSettings),
  );
  const live2dPresentationSettings = reactive(
    cloneLive2dPresentationSettings(
      bridge.state.snapshot.live2dPresentationSettings,
    ),
  );
  const initialMotionPlaybackRecords: DesktopMotionPlaybackRecord[] =
    bridge.state.snapshot.motionPlaybackRecords.map((record) =>
      cloneJson(record) as DesktopMotionPlaybackRecord);
  const { showContextMenu } = useDesktopContextMenu();
  const playbackAck = {
    sendPlaybackFinishedForCurrentGroup: adapter.sendPlaybackFinishedForCurrentGroup,
    clearPlaybackGroupContext: adapter.clearPlaybackGroupContext,
  };
  const motionLabOutboundQueue = createMotionLabOutboundQueue({
    store: createIndexedDbMotionLabPendingEventStore(),
    send: (payload, turnId) => adapter.sendMotionLabRawEvent(payload, turnId),
    onError: (message, error) => {
      const details = error instanceof Error ? error.message : String(error ?? "");
      const diagnostic = details ? `${message} ${details}` : message;
      console.error("[MotionLab]", diagnostic, error);
      adapter.pushHistory("error", diagnostic);
    },
  });

  function sendMotionLabEvent(
    payload: MotionLabRawEventInput,
    turnId: string | null,
  ): void {
    void motionLabOutboundQueue.enqueue(payload, turnId).catch((error) => {
      const details = error instanceof Error ? error.message : String(error);
      const message = `MotionLab event persistence failed: ${details}`;
      console.error("[MotionLab]", message, error);
      adapter.pushHistory("error", message);
    });
  }
  const motionRecord = {
    getLastAssistantText: () => adapter.state.lastAssistantText,
    getSelectedModel: () => selectedModel,
  };
  const playbackCoordinator = usePlaybackCompletionCoordinator({
    sessionStore,
    playbackAck,
  });
  const motionPlaybackRecorder = useMotionPlaybackRecorder({
    motionRecord,
    getPlaybackTimelineSnapshot: (
      turnId,
      messageId,
    ) => playbackTimeline.getTimelineSnapshotForSegment(turnId, messageId),
    onMotionLabRawEvent: (payload, turnId) => {
      sendMotionLabEvent(payload, turnId ?? null);
    },
    initialMotionPlaybackRecords,
  });
  const motionTimelineRunTracker = createPlaybackTimelineMotionRunTracker(playbackTimeline);
  function handleMotionTerminal(event: DirectParameterPlanTerminalEvent): void {
    const completedRun = modelEngine.handlePlaybackTerminal(event);
    if (completedRun?.origin !== "manual_preview") {
      return;
    }
    const status: DesktopMotionPreviewStatus["status"] = event.status;
    bridge.publishMotionPreviewStatus({
      requestId: completedRun.messageId,
      source: "compiled_semantic_motion",
      status,
      runId: event.runId,
      ...(event.reason ? { reason: event.reason } : {}),
    });
  }
  const modelEngine = useModelEngine({
    getSelectedModel: () => selectedModel.value,
    getSettings: () => cloneModelEngineSettings(motionEngineSettings),
    playPlan: (plan, model, options) => motionPlayer.playPlan(plan, model, {
      ...options,
      onFinished: (event) => {
        options?.onFinished?.(event);
        handleMotionTerminal(event);
        motionPlaybackRecorder.completeMotionPlayback(event);
        motionTimelineRunTracker.recordTerminal(event);
      },
    }),
    playCatalogMotion: (motion, model, options) => motionPlayer.playCatalogMotion(motion, model, {
      ...options,
      onFinished: (event) => {
        options?.onFinished?.(event);
        handleMotionTerminal(event);
        motionPlaybackRecorder.completeMotionPlayback(event);
        motionTimelineRunTracker.recordTerminal(event);
      },
    }),
    stopPlan: (reason) => motionPlayer.stopPlan(reason),
    onMotionRejected: ({ turnId, messageId, reason }) =>
      playbackTimeline.rejectMotionBeforeStart(turnId, messageId, reason),
    canStartSpeechOnlyMotion: (turnId, messageId) => {
      const session = sessionStore.getSession(turnId);
      const segment = session?.segments.get(messageId);
      if (!segment) {
        return false;
      }
      return (
        !segment.motion.failed
        && segment.motion.payload === null
        && !segment.motion.released
        && !segment.motion.started
        && !segment.motion.completed
      );
    },
    pushHistory: (role, text) => adapter.pushHistory(role, text),
    getPlayerMessage: () => motionPlayer.state.message,
    onPlanStarted: (event) => {
      console.info("[MotionLifecycle] plan started callback received.", {
        playbackOrigin: event.playbackOrigin,
        startReason: event.startReason,
        turnId: event.turnId,
        playbackTurnId: event.playbackTurnId,
        messageId: event.messageId,
        runId: event.runId,
        payloadKind: event.payloadKind,
      });
      motionTimelineRunTracker.recordStarted(event);
      motionPlaybackRecorder.recordMotionPlayback(event);
      if (event.playbackOrigin === "manual_preview") {
        bridge.publishMotionPreviewStatus({
          requestId: event.messageId,
          source: "compiled_semantic_motion",
          status: "started",
          runId: event.runId,
        });
      }
    },
    onCompileFailed: (event) => {
      sendMotionLabEvent({
        event_type: "motion.frontend_compile_failed",
        message_id: event.messageId,
        source_route: event.startReason,
        phase: "frontend_compile_failed",
        model_name: event.model?.name ?? "",
        profile_id: event.payloadKind === "speech_only"
          ? event.request.profileId
          : event.intent.profile_id,
        profile_revision: event.payloadKind === "speech_only"
          ? event.request.profileRevision
          : event.intent.profile_revision,
        payload_kind: event.payloadKind,
        raw: {
          intent: event.payloadKind === "semantic_intent" ? cloneJson(event.intent) : null,
          speechOnlyRequest: event.payloadKind === "speech_only"
            ? cloneJson(event.request)
            : null,
          feedback: event.feedback ? cloneJson(event.feedback) : null,
          diagnostics: cloneJson(event.diagnostics),
          playbackOrigin: event.playbackOrigin,
          reason: event.reason,
          playbackTurnId: event.playbackTurnId,
          queuedDelayMs: event.queuedDelayMs,
        },
      }, event.turnId);
    },
  });
  const playbackTimelineMotionRuntime = configurePlaybackTimelineMotionRuntime({
    playbackTimeline,
    motionEngine: modelEngine,
    onMissingPlaybackTimeline: (turnId, messageId) => {
      console.error("[AG99live] audio timeline started without matching playback timeline.", {
        turnId,
        messageId,
      });
    },
  });
  const stopMotionLabReconnectWatch = watch(
    () => adapter.state.status,
    (status) => {
      if (status === "connected") {
        motionLabOutboundQueue.handleConnected();
      } else {
        motionLabOutboundQueue.handleDisconnected();
      }
    },
    { immediate: true },
  );
  adapter.setMotionLabRawEventRecordedHandler((eventId) => {
    console.info("[MotionLab] backend persistence acknowledged.", {
      eventId,
    });
    void motionLabOutboundQueue.acknowledgePersisted(eventId).catch((error) => {
      const details = error instanceof Error ? error.message : String(error);
      const message = `MotionLab persisted acknowledgement failed: ${details}`;
      console.error("[MotionLab]", message, error);
      adapter.pushHistory("error", message);
    });
  });
  const motionTimelineSink = playbackTimelineMotionRuntime.motionTimelineSink;
  motionTimelineSinkTarget = motionTimelineSink;

  useTurnPlaybackOrchestrator({
    sessionStore,
    timelineRuntime: {
      startSegmentJob: playbackTimeline.startSegmentJob,
      rejectMotionBeforeStart: playbackTimeline.rejectMotionBeforeStart,
    },
  });

  applyModelEngineSettings(motionEngineSettings, bridge.state.snapshot.motionEngineSettings);

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
    if (adapter.state.isPlayingAudio) {
      return "speaking";
    }
    if (sessionStore.getSessions().some((session) => !isTerminalPhase(session.phase))) {
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
  const pushToTalk = usePushToTalkController(adapter);
  let snapshotPublisher: ReturnType<typeof createPetRuntimeSnapshotPublisher> | null = null;
  const bilibiliLive = useBilibiliLiveRuntime({
    sendText: (text) => adapter.sendText(text),
    pushHistory: (role, text) => adapter.pushHistory(role, text),
    onStatusChanged: () => {
      snapshotPublisher?.publishRuntimeSnapshot();
    },
  });

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
    motionEngineSettings,
    live2dPresentationSettings,
    motionPlaybackRecords: motionPlaybackRecorder.motionPlaybackRecords,
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
    motionEngineSettings,
    live2dPresentationSettings,
    modelEngine: {
      stop: (reason) => modelEngine.stop(reason),
      state: modelEngine.state,
      previewCompiledSemanticMotion: modelEngine.previewCompiledSemanticMotion,
    },
    snapshotPublisher,
    saveMotionTuningSample,
    deleteMotionTuningSample,
    publishMotionPreviewStatus: bridge.publishMotionPreviewStatus,
    setBilibiliLiveSettings: bilibiliLive.applySettings,
  });

  const detachBridgeListener = bridge.onCommand(commandHandler.handleCommand);
  const detachProfileAuthoringBridgeListener = bridge.onProfileAuthoringCommand(
    commandHandler.handleProfileAuthoringCommand,
  );

  onMounted(async () => {
    await adapter.initialize();
    adapter.connect();
    pushToTalk.install();
    bilibiliLive.start();
  });

  onBeforeUnmount(() => {
    stopMotionLabReconnectWatch();
    adapter.setMotionLabRawEventRecordedHandler(null);
    motionLabOutboundQueue.dispose();
    playbackTimelineMotionRuntime.dispose();
    motionTimelineSinkTarget = null;
    pushToTalk.dispose();
    bilibiliLive.dispose();
    playbackCoordinator.resetPlaybackCoordination();
    motionPlaybackRecorder.resetMotionPlaybackRecorder();
    motionTimelineRunTracker.clear();
    modelEngine.stop("unmount");
    detachBridgeListener();
    detachProfileAuthoringBridgeListener();
    snapshotPublisher?.dispose();
  });

  const runtime: PetDesktopRuntime = {
    sessionStore,
    selectedModel,
    motionEngineSettings,
    live2dPresentationSettings,
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
