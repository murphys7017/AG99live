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
import type { DesktopRuntimeSettingsAccess } from "../adapter-connection/features/desktopSettings.js";
import { createModelSync } from "../adapter-connection/model-sync/useModelSync";
import { useDesktopBridge } from "../desktop-bridge/useDesktopBridge";
import { createPetRuntimeSnapshotPublisher } from "../desktop-bridge/usePetRuntimeSnapshotPublisher";
import { usePreviewMotionPlayer } from "../live2d-renderer/usePreviewMotionPlayer";
import {
  applyLive2dPresentationSettingsSnapshot,
  cloneLive2dPresentationSettings,
  type Live2dPresentationSettings,
} from "../live2d-renderer/settings";
import { useModelEngine } from "../model-engine/useModelEngine";
import { normalizeMotionPayload } from "../model-engine/normalize";
import { reportLatencyStage } from "../adapter-connection/runtime/latency.js";
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
  createPlaybackTimelineMotionRunTracker,
} from "./playbackTimelineWiring";
import { useDesktopContextMenu } from "./useDesktopContextMenu";
import { createDesktopRuntimeCommandHandler } from "../desktop-bridge/useDesktopRuntimeCommandHandler";
import { usePushToTalkController } from "./usePushToTalkController";
import { useBilibiliLiveRuntime } from "../bilibili-live/useBilibiliLiveRuntime";
import { isSegmentLocallySettled, isTerminalPhase } from "../turn-playback/session";
import {
  createIndexedDbMotionLabPendingEventStore,
  createMotionLabOutboundQueue,
  type MotionLabRawEventInput,
} from "../motion-lab/outboundQueue";
import { createConversationPlaybackRuntime } from "./createConversationPlaybackRuntime";
import { useCursorGaze } from "./useCursorGaze";
import {
  createPresenceStateStore,
  type PresenceConversationPhase,
  type PresenceRendererStatus,
} from "../presence/presenceStateStore";

export interface PetDesktopRuntime {
  sessionStore: ReturnType<typeof useTurnPlaybackSessionStore>;
  selectedModel: ReturnType<typeof createModelSync>["selectedModel"];
  motionEngineSettings: ModelEngineSettings;
  live2dPresentationSettings: Live2dPresentationSettings;
  stageMessage: ComputedRef<string>;
  showContextMenu: ReturnType<typeof useDesktopContextMenu>["showContextMenu"];
  reportRendererStatus: (status: PresenceRendererStatus) => void;
}

export const petDesktopRuntimeKey: InjectionKey<PetDesktopRuntime> =
  Symbol("AG99livePetDesktopRuntime");

function isSameConversationTurn(left: string, right: string): boolean {
  return left === right
    || left.startsWith(`${right}:vad:`)
    || right.startsWith(`${left}:vad:`);
}

export function providePetDesktopRuntime(): PetDesktopRuntime {
  const sessionStore = useTurnPlaybackSessionStore({ normalizeMotionPayload });
  const modelSync = createModelSync();
  const { state, selectedModel, selectedSemanticAxisProfile } = modelSync;
  const presenceStateStore = createPresenceStateStore({
    onSnapshot: (snapshot) => {
      console.info("[PresenceState] transition.", {
        revision: snapshot.revision,
        source: snapshot.lastTransition?.source,
        type: snapshot.lastTransition?.type,
        connection: snapshot.connectionStatus,
        phase: snapshot.conversationPhase,
        playback: snapshot.playback,
        microphone: snapshot.microphone.status,
        attention: snapshot.attentionTarget,
        model: snapshot.model.selection,
        renderer: snapshot.model.rendererStatus,
        mode: snapshot.mode,
      });
    },
  });
  let presencePreparationRevision = 0;
  let activePresencePreparation: {
    turnId: string;
    requestId: string;
    revision: number;
  } | null = null;
  function clearPresencePreparation(turnId?: string | null, requestId?: string): void {
    const active = activePresencePreparation;
    if (!active) {
      return;
    }
    if (typeof turnId === "string" && !isSameConversationTurn(active.turnId, turnId)) {
      return;
    }
    if (requestId !== undefined && active.requestId !== requestId) {
      return;
    }
    presenceStateStore.dispatch({
      source: "pre_action",
      type: "conversation.preparation.changed",
      pending: false,
      revision: active.revision,
    });
    activePresencePreparation = null;
  }
  useCursorGaze(selectedModel, (active) => {
    presenceStateStore.dispatch({
      source: "cursor_gaze",
      type: "attention.changed",
      active,
    });
  });
  const bridge = useDesktopBridge();
  const motionEngineSettings = reactive(
    cloneModelEngineSettings(bridge.state.snapshot.motionEngineSettings),
  );
  const live2dPresentationSettings = reactive(
    cloneLive2dPresentationSettings(
      bridge.state.snapshot.live2dPresentationSettings,
    ),
  );
  const desktopRuntimeSettings: DesktopRuntimeSettingsAccess = {
    currentAmbientMotionEnabled: () => live2dPresentationSettings.ambientMotionEnabled,
    applyAmbientMotionEnabled: (enabled) => {
      applyLive2dPresentationSettingsSnapshot(live2dPresentationSettings, {
        ...live2dPresentationSettings,
        ambientMotionEnabled: enabled,
      });
    },
    currentPhysicsResponseScale: () => live2dPresentationSettings.physicsResponseScale,
    applyPhysicsResponseScale: (scale) => {
      applyLive2dPresentationSettingsSnapshot(live2dPresentationSettings, {
        ...live2dPresentationSettings,
        physicsResponseScale: scale,
      });
    },
    currentRenderDprCap: () => live2dPresentationSettings.renderDprCap,
    applyRenderDprCap: (cap) => {
      applyLive2dPresentationSettingsSnapshot(live2dPresentationSettings, {
        ...live2dPresentationSettings,
        renderDprCap: cap,
      });
    },
    currentMotionIntensityScale: () => motionEngineSettings.motionIntensityScale,
    applyMotionIntensityScale: (scale) => {
      applyModelEngineSettings(motionEngineSettings, {
        ...motionEngineSettings,
        motionIntensityScale: scale,
      });
    },
  };
  const conversationPlayback = createConversationPlaybackRuntime({
    sessionStore,
    modelSync,
    normalizeMotionPayload,
    desktopRuntimeSettings,
  });
  const { adapter, playbackTimeline } = conversationPlayback;
  watch(
    () => adapter.state.status,
    (status) => {
      presenceStateStore.dispatch({
        source: "adapter_connection",
        type: "connection.changed",
        status,
      });
    },
    { immediate: true },
  );
  watch(
    () => [adapter.state.micCapturing, adapter.state.microphoneStandby] as const,
    ([capturing, standby]) => {
      presenceStateStore.dispatch({
        source: "adapter_microphone",
        type: "microphone.changed",
        capturing,
        standby,
      });
    },
    { immediate: true },
  );
  watch(
    () => adapter.state.isPlayingAudio,
    (playing) => {
      presenceStateStore.dispatch({
        source: "playback_audio",
        type: "playback.changed",
        playing,
      });
    },
    { immediate: true },
  );
  let modelSelectionRevision = 0;
  watch(
    () => selectedModel.value?.model_url ?? null,
    (modelKey, previousModelKey) => {
      if (modelKey === previousModelKey || (previousModelKey === undefined && modelKey === null)) {
        return;
      }
      modelSelectionRevision += 1;
      presenceStateStore.dispatch({
        source: "model_sync",
        type: "model.selection.changed",
        selected: modelKey !== null,
        selectionRevision: modelSelectionRevision,
      });
    },
    { immediate: true },
  );
  watch(
    [
      () => sessionStore.getActiveSession()?.id ?? null,
      () => sessionStore.getActiveSession()?.phase ?? null,
      () => sessionStore.getActiveSession()?.interrupted ?? false,
    ],
    () => {
      const session = sessionStore.getActiveSession();
      let phase: Exclude<PresenceConversationPhase, "preparing" | "speaking"> = "idle";
      if (session?.interrupted) {
        phase = "interrupted";
      } else if (session) {
        switch (session.phase) {
          case "collecting":
          case "ready":
          case "playing":
            phase = "thinking";
            break;
          case "settling":
            phase = "settling";
            break;
          case "completed":
            phase = "completed";
            break;
          case "failed":
            phase = "failed";
            break;
        }
      }
      presenceStateStore.dispatch({
        source: "playback_session",
        type: "conversation.phase.changed",
        phase,
      });
    },
    { immediate: true },
  );
  function reportRendererStatus(status: PresenceRendererStatus): void {
    presenceStateStore.dispatch({
      source: "live2d_renderer",
      type: "model.renderer_status.changed",
      status,
    });
  }
  const motionPlayer = usePreviewMotionPlayer();
  const manualPreviewText = ref("");
  let manualPreviewRequestId = "";
  const approvedAssistantSegmentKeys = reactive(new Set<string>());
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
  function findLatestCompletedAssistantSegment(): {
    turnId: string;
    messageId: string;
    assistantText: string;
  } | null {
    const sessions = sessionStore.getSessions();
    for (let sessionIndex = sessions.length - 1; sessionIndex >= 0; sessionIndex -= 1) {
      const session = sessions[sessionIndex];
      const turnId = session.turnId?.trim() ?? "";
      if (!turnId) {
        continue;
      }
      for (let segmentIndex = session.segmentOrder.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
        const messageId = session.segmentOrder[segmentIndex];
        const segment = session.segments.get(messageId);
        const assistantText = segment?.text.content?.trim() ?? "";
        if (!segment || !assistantText || !isSegmentLocallySettled(segment)) {
          continue;
        }
        return { turnId, messageId, assistantText };
      }
    }
    return null;
  }
  const latestAssistantFeedback = computed(() => {
    const segment = findLatestCompletedAssistantSegment();
    if (!segment) {
      return { available: false, approved: false };
    }
    const key = `${segment.turnId}:${segment.messageId}`;
    return {
      available: true,
      approved: approvedAssistantSegmentKeys.has(key),
    };
  });
  function beginManualPreviewPresentation(requestId: string, assistantText: string): void {
    manualPreviewRequestId = requestId.trim();
    manualPreviewText.value = assistantText.trim();
  }
  function clearManualPreviewPresentation(requestId: string): void {
    if (manualPreviewRequestId !== requestId.trim()) {
      return;
    }
    manualPreviewRequestId = "";
    manualPreviewText.value = "";
  }
  function approveLatestAssistantSegment(): boolean {
    const segment = findLatestCompletedAssistantSegment();
    if (!segment) {
      return false;
    }
    const segmentKey = `${segment.turnId}:${segment.messageId}`;
    if (approvedAssistantSegmentKeys.has(segmentKey)) {
      return false;
    }
    approvedAssistantSegmentKeys.add(segmentKey);
    sendMotionLabEvent({
      event_type: "motion.feedback_positive",
      message_id: segment.messageId,
      source_route: "pet_overlay",
      phase: "assistant_segment_feedback",
      assistant_text: segment.assistantText,
      raw: {
        feedback: "positive",
        interaction: "overlay_thumbs_up",
        turnId: segment.turnId,
        messageId: segment.messageId,
      },
    }, segment.turnId);
    return true;
  }
  const motionRecord = {
    getSelectedModel: () => selectedModel,
  };
  const getCanonicalAssistantText = (
    turnId: string | null,
    messageId: string,
  ): string => sessionStore.getSession(turnId)?.segments.get(messageId)?.text.content ?? "";
  const getCanonicalSpeechCues = (
    turnId: string | null,
    messageId: string,
  ) => sessionStore.getSession(turnId)?.segments.get(messageId)?.speech.cues ?? [];
  const playbackCoordinator = usePlaybackCompletionCoordinator({
    sessionStore,
    playbackAck,
    timelineRuntime: playbackTimeline,
  });
  const motionPlaybackRecorder = useMotionPlaybackRecorder({
    motionRecord,
    getCanonicalAssistantText,
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
  function notifyMotionLifecycleObserver(
    phase: "started" | "terminal",
    observer: string,
    runId: string,
    notify: () => void,
  ): void {
    try {
      notify();
    } catch (error) {
      console.error(`[MotionLifecycle] ${phase} observer '${observer}' failed.`, {
        runId,
        error,
      });
    }
  }
  function handleMotionTerminal(
    event: DirectParameterPlanTerminalEvent,
    localObserver?: (event: DirectParameterPlanTerminalEvent) => void,
  ): void {
    notifyMotionLifecycleObserver("terminal", "model_engine", event.runId, () => {
      const completedRun = modelEngine.handlePlaybackTerminal(event);
      if (completedRun?.origin === "pre_action") {
        reportLatencyStage("pre_action_ended", completedRun.turnId, null, completedRun.messageId);
        clearPresencePreparation(completedRun.turnId, completedRun.messageId);
      }
      if (completedRun?.origin !== "manual_preview") {
        return;
      }
      clearManualPreviewPresentation(completedRun.messageId);
      snapshotPublisher?.publishRuntimeSnapshot();
      const status: DesktopMotionPreviewStatus["status"] = event.status;
      bridge.publishMotionPreviewStatus({
        requestId: completedRun.messageId,
        source: "compiled_semantic_motion",
        status,
        runId: event.runId,
        ...(event.reason ? { reason: event.reason } : {}),
      });
    });
    notifyMotionLifecycleObserver("terminal", "playback_timeline", event.runId, () => {
      motionTimelineRunTracker.recordTerminal(event);
    });
    notifyMotionLifecycleObserver("terminal", "motion_recorder", event.runId, () => {
      motionPlaybackRecorder.completeMotionPlayback(event);
    });
    if (localObserver) {
      notifyMotionLifecycleObserver("terminal", "caller", event.runId, () => {
        localObserver(event);
      });
    }
  }
  const modelEngine = useModelEngine({
    startIdlePlan: (plan) => window.getLAppAdapter?.()?.startIdleParameterPlan?.(plan) ?? false,
    stopIdlePlan: () => window.getLAppAdapter?.()?.stopIdleParameterPlan?.(),
    getSelectedModel: () => selectedModel.value,
    getSettings: () => cloneModelEngineSettings(motionEngineSettings),
    playPlan: (plan, model, options) => motionPlayer.playPlan(plan, model, {
      ...options,
      onFinished: (event) => {
        handleMotionTerminal(event, options?.onFinished);
      },
    }),
    playMotionResource: (motion, model, options) => motionPlayer.playMotionResource(motion, model, {
      ...options,
      onFinished: (event) => {
        handleMotionTerminal(event, options?.onFinished);
      },
    }),
    stopPlan: (reason) => motionPlayer.stopPlan(reason),
    startInteractionSway: (input) => (
      window.getLAppAdapter?.().startInteractionSway?.(input) ?? false
    ),
    stopInteractionSway: () => {
      window.getLAppAdapter?.().stopInteractionSway?.();
    },
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
        && !segment.motion.pending
        && segment.incremental?.streams.motion?.status !== "open"
        && segment.motion.payload === null
        && !segment.motion.released
        && !segment.motion.started
        && !segment.motion.completed
      );
    },
    pushHistory: (role, text) => adapter.pushHistory(role, text),
    getPlayerMessage: () => motionPlayer.state.message,
    onPlanStarted: (event) => {
      if (event.playbackOrigin === "pre_action") {
        reportLatencyStage("pre_action_started", event.turnId, null, event.messageId);
      }
      console.info("[MotionLifecycle] plan started callback received.", {
        playbackOrigin: event.playbackOrigin,
        startReason: event.startReason,
        turnId: event.turnId,
        playbackTurnId: event.playbackTurnId,
        messageId: event.messageId,
        runId: event.runId,
        payloadKind: event.payloadKind,
      });
      notifyMotionLifecycleObserver("started", "playback_timeline", event.runId, () => {
        motionTimelineRunTracker.recordStarted(event);
      });
      notifyMotionLifecycleObserver("started", "motion_recorder", event.runId, () => {
        motionPlaybackRecorder.recordMotionPlayback(event);
      });
      if (event.playbackOrigin === "manual_preview") {
        notifyMotionLifecycleObserver("started", "desktop_bridge", event.runId, () => {
          bridge.publishMotionPreviewStatus({
            requestId: event.messageId,
            source: "compiled_semantic_motion",
            status: "started",
            runId: event.runId,
          });
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
    getCanonicalAssistantText,
    getCanonicalSpeechCues,
    onMissingPlaybackTimeline: (turnId, messageId) => {
      console.error("[AG99live] audio timeline started without matching playback timeline.", {
        turnId,
        messageId,
      });
    },
    onMotionPreparationNotApplicable: ({ turnId, messageId, timelineId, reason }) => {
      sendMotionLabEvent({
        event_type: "motion.frontend_preparation_not_applicable",
        message_id: messageId,
        source_route: "playback_timeline",
        phase: "frontend_preparation",
        assistant_text: getCanonicalAssistantText(turnId, messageId),
        raw: {
          reason,
          timelineId,
        },
      }, turnId);
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
  adapter.setMotionLabRawEventRejectedHandler((eventId, reason) => {
    void motionLabOutboundQueue.rejectPersisted(eventId, reason).catch((error) => {
      const details = error instanceof Error ? error.message : String(error);
      const message = `MotionLab rejected-event cleanup failed: ${details}`;
      console.error("[MotionLab]", message, error);
      adapter.pushHistory("error", message);
    });
  });
  adapter.setMotionLabRawEventReporter((payload, turnId) => {
    sendMotionLabEvent(payload, turnId);
  });
  conversationPlayback.bindMotionTimelineRuntime(playbackTimelineMotionRuntime);

  const turnPlaybackOrchestrator = useTurnPlaybackOrchestrator({
    sessionStore,
    timelineRuntime: playbackTimeline,
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
      state.runtimeCacheErrors,
    ),
  );
  adapter.setTurnLifecycleObserver((event) => {
    if (event.phase === "started") {
      presenceStateStore.dispatch({
        source: "playback_session",
        type: "conversation.phase.changed",
        phase: "thinking",
      });
      clearPresencePreparation(event.turnId);
      modelEngine.cancelIdleMotion();
      modelEngine.startThinkingSway(event.turnId);
      return;
    }
    clearPresencePreparation(event.turnId);
    modelEngine.releaseThinkingSway(event.turnId);
    modelEngine.cancelPreAction(event.turnId);
  });
  adapter.setPreActionObserver((event) => {
    modelEngine.cancelIdleMotion();
    if (event.action === "ready") {
      const started = modelEngine.startPreAction(event.motion, event.turnId, event.requestId);
      if (started) {
        const revision = ++presencePreparationRevision;
        activePresencePreparation = {
          turnId: event.turnId,
          requestId: event.requestId,
          revision,
        };
        presenceStateStore.dispatch({
          source: "pre_action",
          type: "conversation.preparation.changed",
          pending: true,
          revision,
        });
      }
      console.info("[PreAction] execution admission.", { turnId: event.turnId, requestId: event.requestId, started });
    } else if (event.action === "input") {
      clearPresencePreparation();
      modelEngine.cancelPreAction();
    } else {
      clearPresencePreparation(event.turnId, event.requestId);
      modelEngine.cancelPreAction(event.turnId, event.requestId);
    }
  });
  const idleMotionAllowed = computed(() => {
    const s = adapter.state;
    return s.status === "connected" && !s.isPlayingAudio
      && !(s.micCapturing && !s.microphoneStandby) && !manualPreviewText.value
      && (!s.currentTurnId || s.turnFinishedTurnId === s.currentTurnId)
      && !sessionStore.getSessions().some((session) => !isTerminalPhase(session.phase));
  });
  adapter.setIdleMotionObserver((event) => {
    if (!idleMotionAllowed.value) return;
    try {
      modelEngine.startIdleMotion(event.motion, event.expiresAt);
    } catch (error) {
      console.warn("[IdleMotion] optional playback failed.", error);
    }
  });
  watch(idleMotionAllowed, (allowed) => {
    if (!allowed) modelEngine.cancelIdleMotion();
  }, { flush: "sync" });
  watch(() => {
    const model = selectedModel.value;
    const profile = model?.semantic_axis_profile;
    return [model?.model_path, profile?.profile_id, profile?.revision, profile?.source_hash].join(":");
  }, () => {
    modelEngine.cancelIdleMotion();
    modelEngine.cancelPreAction();
    clearPresencePreparation();
  });
  const pushToTalk = usePushToTalkController(adapter);
  let snapshotPublisher: ReturnType<typeof createPetRuntimeSnapshotPublisher> | null = null;
  const bilibiliLive = useBilibiliLiveRuntime({
    sendText: (text) => adapter.sendText(text),
    pushHistory: (role, text) => adapter.pushHistory(role, text),
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
    manualPreviewText,
    latestAssistantFeedback,
    bilibiliLiveStatus: bilibiliLive.status,
  });

  const commandHandler = createDesktopRuntimeCommandHandler({
    adapter,
    motionEngineSettings,
    live2dPresentationSettings,
    modelEngine: {
      stop: (reason) => modelEngine.stop(reason),
      state: modelEngine.state,
      previewCompiledSemanticMotion: modelEngine.previewCompiledSemanticMotion,
      previewRecordedParameterPlan: modelEngine.previewRecordedParameterPlan,
    },
    snapshotPublisher,
    saveMotionTuningSample,
    deleteMotionTuningSample,
    publishMotionPreviewStatus: bridge.publishMotionPreviewStatus,
    beginManualPreviewPresentation,
    approveLatestAssistantSegment,
    setBilibiliLiveSettings: bilibiliLive.applySettings,
  });

  const detachBridgeListener = bridge.onCommand(commandHandler.handleCommand);
  const detachProfileAuthoringBridgeListener = bridge.onProfileAuthoringCommand(
    commandHandler.handleProfileAuthoringCommand,
  );

  onMounted(async () => {
    await adapter.initialize();
    await adapter.connect();
    pushToTalk.install();
    bilibiliLive.start();
  });

  onBeforeUnmount(async () => {
    const cleanupErrors: unknown[] = [];
    const cleanupSteps: Array<readonly [string, () => void]> = [
      ["Thinking sway release", () => {
        adapter.setTurnLifecycleObserver(null);
        modelEngine.releaseThinkingSway();
      }],
      ["pre-action observer detach", () => adapter.setPreActionObserver(null)],
      ["presence state store dispose", () => presenceStateStore.dispose()],
      ["MotionLab reconnect watch stop", stopMotionLabReconnectWatch],
      ["MotionLab recorded handler detach", () => {
        adapter.setMotionLabRawEventRecordedHandler(null);
      }],
      ["MotionLab reporter detach", () => {
        adapter.setMotionLabRawEventReporter(null);
      }],
      ["MotionLab rejected-event handler detach", () => {
        adapter.setMotionLabRawEventRejectedHandler(null);
      }],
      ["MotionLab outbound queue dispose", () => motionLabOutboundQueue.dispose()],
      ["push-to-talk dispose", () => pushToTalk.dispose()],
      ["Bilibili Live dispose", () => bilibiliLive.dispose()],
      ["playback coordination reset", () => playbackCoordinator.resetPlaybackCoordination()],
      ["playback coordinator dispose", () => playbackCoordinator.dispose()],
      ["turn playback orchestrator dispose", () => turnPlaybackOrchestrator.dispose()],
      ["motion playback recorder reset", () => {
        motionPlaybackRecorder.resetMotionPlaybackRecorder();
      }],
      ["motion Timeline run tracker clear", () => motionTimelineRunTracker.clear()],
      ["ModelEngine stop", () => modelEngine.stop("unmount")],
      ["desktop bridge listener detach", detachBridgeListener],
      ["profile authoring bridge listener detach", detachProfileAuthoringBridgeListener],
      ["runtime snapshot publisher dispose", () => snapshotPublisher?.dispose()],
    ];
    for (const [step, cleanup] of cleanupSteps) {
      try {
        cleanup();
      } catch (error) {
        console.error(`[PetDesktopRuntime] ${step} failed.`, error);
        cleanupErrors.push(error);
      }
    }
    try {
      await conversationPlayback.dispose();
    } catch (error) {
      console.error("[PetDesktopRuntime] adapter dispose failed.", error);
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw cleanupErrors[0];
    }
  });

  const runtime: PetDesktopRuntime = {
    sessionStore,
    selectedModel,
    motionEngineSettings,
    live2dPresentationSettings,
    stageMessage,
    showContextMenu,
    reportRendererStatus,
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
