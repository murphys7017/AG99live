import { onScopeDispose, watch, type ComputedRef, type Ref } from "vue";
import { cloneModelEngineSettings, type ModelEngineSettings } from "../model-engine/settings";
import type {
  DesktopBaseActionPreview,
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopHistoryEntry,
  DesktopMicrophoneDevice,
  DesktopModelProjectionSnapshot,
  DesktopMotionPlaybackRecord,
  DesktopSemanticAxisProfileSaveResult,
  DesktopMotionTuningSamplesStatus,
  DesktopMotionTuningSample,
} from "../types/desktop";
import type { ModelSummary, SystemServerInfoPayload } from "../types/protocol";
import type { SemanticAxisProfile } from "../types/semantic-axis-profile";
import type { useModelSync } from "../adapter-connection/model-sync/useModelSync";
import type { useTurnPlaybackSessionStore } from "../turn-playback/useTurnPlaybackSessionStore";
import {
  buildAdapterRuntimeProjection,
  buildDesktopRuntimeSnapshot,
  getActiveSegmentSnapshot,
  type SessionProjectionInput,
} from "./projection.js";
import { cloneJson } from "../utils/cloneJson.js";

type ModelSync = ReturnType<typeof useModelSync>;

const SNAPSHOT_DEBOUNCE_MS = 60;

interface PetRuntimeSnapshotAdapterPort {
  readonly state: {
    readonly address: string;
    readonly desktopScreenshotOnSendEnabled: boolean;
    readonly microphoneDeviceId: string;
    readonly microphoneDevices: readonly DesktopMicrophoneDevice[];
    readonly statusMessage: string;
    readonly serverInfo: SystemServerInfoPayload | null;
    readonly lastAssistantText: string;
    readonly lastTranscription: string;
    readonly lastImageCount: number;
    readonly currentTurnId: string | null;
    readonly micRequested: boolean;
    readonly micCapturing: boolean;
    readonly isPlayingAudio: boolean;
    readonly pttModeEnabled: boolean;
    readonly historyEntries: readonly DesktopHistoryEntry[];
    readonly backendHistorySummaries: readonly DesktopBackendHistorySummary[];
    readonly backendHistoryEntries: readonly DesktopBackendHistoryMessage[];
    readonly activeBackendHistoryUid: string;
    readonly backendHistoryLoading: boolean;
    readonly backendHistoryStatusMessage: string;
    readonly motionTuningSamples: readonly unknown[];
    readonly motionTuningSamplesStatus: DesktopMotionTuningSamplesStatus;
    readonly latestSemanticAxisProfileSaveResult: DesktopSemanticAxisProfileSaveResult | null;
  };
}

interface PetRuntimeSnapshotBridgePort {
  publishSnapshot: (snapshot: ReturnType<typeof buildDesktopRuntimeSnapshot>) => void;
  publishMotionTuningSamples: (
    samples: unknown,
    status: DesktopMotionTuningSamplesStatus,
  ) => void;
  publishModelProjectionSnapshot: (snapshot: DesktopModelProjectionSnapshot) => void;
  publishProfileAuthoringSnapshot: (snapshot: {
    latestSemanticAxisProfileSaveResult: DesktopSemanticAxisProfileSaveResult | null;
  }) => void;
}

interface PetRuntimeSnapshotPublisherOptions {
  adapter: PetRuntimeSnapshotAdapterPort;
  bridge: PetRuntimeSnapshotBridgePort;
  modelSyncState: ModelSync["state"];
  selectedModel: Ref<ModelSummary | null>;
  selectedSemanticAxisProfile: Ref<SemanticAxisProfile | null>;
  ambientMotionEnabled: Ref<boolean>;
  motionEngineSettings: ModelEngineSettings;
  motionPlaybackRecords: { readonly value: readonly DesktopMotionPlaybackRecord[] };
  parameterActionPreview: ComputedRef<DesktopBaseActionPreview | null>;
  connectionState: ComputedRef<string>;
  connectionLabel: ComputedRef<string>;
  stageMessage: ComputedRef<string>;
  aiState: ComputedRef<string>;
  sessionStore: ReturnType<typeof useTurnPlaybackSessionStore>;
}

function createDebounce(): {
  schedule(fn: () => void): void;
  flush(): void;
  cancel(): void;
} {
  let timerId = 0;
  let pending: (() => void) | null = null;

  function schedule(fn: () => void): void {
    pending = fn;
    if (timerId) {
      return;
    }
    timerId = window.setTimeout(() => {
      timerId = 0;
      const task = pending;
      pending = null;
      task?.();
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  function flush(): void {
    if (timerId) {
      window.clearTimeout(timerId);
      timerId = 0;
    }
    const task = pending;
    pending = null;
    task?.();
  }

  function cancel(): void {
    pending = null;
    if (timerId) {
      window.clearTimeout(timerId);
      timerId = 0;
    }
  }

  return { schedule, flush, cancel };
}

export function usePetRuntimeSnapshotPublisher(
  options: PetRuntimeSnapshotPublisherOptions,
): { publishModelProjectionSnapshot: () => void } {
  const snapshotDebounce = createDebounce();
  const modelProjectionDebounce = createDebounce();
  const profileDebounce = createDebounce();

  // ── Runtime snapshot ────────────────────────────────────────────
  // Build adapter + session projections from source state,
  // then assemble the final snapshot.

  watch(
    () => {
      const a = options.adapter.state;
      const adapterProjection = buildAdapterRuntimeProjection({
        address: a.address,
        desktopScreenshotOnSendEnabled: a.desktopScreenshotOnSendEnabled,
        microphoneDeviceId: a.microphoneDeviceId,
        microphoneDevices: a.microphoneDevices.map((device) => ({ ...device })),
        statusMessage: a.statusMessage,
        serverWsUrl: a.serverInfo?.ws_url ?? "",
        httpBaseUrl: a.serverInfo?.http_base_url ?? "",
        lastAssistantText: a.lastAssistantText,
        lastTranscription: a.lastTranscription,
        lastImageCount: a.lastImageCount,
        currentTurnId: a.currentTurnId,
        micRequested: a.micRequested,
        micCapturing: a.micCapturing,
        isPlayingAudio: a.isPlayingAudio,
        pttModeEnabled: a.pttModeEnabled,
        historyEntries: [...a.historyEntries],
        backendHistorySummaries: [...a.backendHistorySummaries],
        backendHistoryEntries: [...a.backendHistoryEntries],
        activeBackendHistoryUid: a.activeBackendHistoryUid,
        backendHistoryLoading: a.backendHistoryLoading,
        backendHistoryStatusMessage: a.backendHistoryStatusMessage,
        motionTuningSamples: a.motionTuningSamples.map((s) =>
          cloneJson(s),
        ) as DesktopMotionTuningSample[],
        motionTuningSamplesStatus: cloneJson(a.motionTuningSamplesStatus) as DesktopMotionTuningSamplesStatus,
      });

      const activeSession = options.sessionStore.getActiveSession();
      const segmentSnapshot = getActiveSegmentSnapshot(activeSession);
      const sessionProjection: SessionProjectionInput = {
        activeSessionId: options.sessionStore.state.activeSessionId,
        activeSessionPhase: activeSession?.phase ?? "",
        activeSessionTextReady: segmentSnapshot?.textReady ?? false,
        activeSessionAudioTerminal: segmentSnapshot?.audioTerminal ?? "idle",
        activeSessionMotionStarted: segmentSnapshot?.motionStarted ?? false,
        activeSessionMotionCompleted: segmentSnapshot?.motionCompleted ?? false,
        activeSessionSynthFinished: activeSession?.backend.synthFinished ?? false,
        activeSessionTurnFinished: activeSession?.backend.turnFinished ?? false,
      };

      return {
        adapter: adapterProjection,
        session: sessionProjection,
        ambientMotionEnabled: options.ambientMotionEnabled.value,
        motionEngineSettings: cloneModelEngineSettings(options.motionEngineSettings),
        motionPlaybackRecords: options.motionPlaybackRecords.value,
        connectionState: options.connectionState.value,
        connectionLabel: options.connectionLabel.value,
        stageMessage: options.stageMessage.value,
        aiState: options.aiState.value,
        confName: options.modelSyncState.confName,
        lastUpdated: options.modelSyncState.lastUpdated,
      };
    },
    (input) => {
      snapshotDebounce.schedule(() => {
        options.bridge.publishSnapshot(
          buildDesktopRuntimeSnapshot(input),
        );
      });
    },
    { deep: true, immediate: true },
  );

  // ── Motion tuning projection ────────────────────────────────────

  watch(
    () => ({
      samples: options.adapter.state.motionTuningSamples,
      status: options.adapter.state.motionTuningSamplesStatus,
    }),
    ({ samples, status }) => {
      snapshotDebounce.schedule(() => {
      options.bridge.publishMotionTuningSamples(
        samples.map((sample) => cloneJson(sample)),
        cloneJson(status) as DesktopMotionTuningSamplesStatus,
      );
      });
    },
    { deep: true, immediate: true },
  );

  // ── Model projection snapshot ────────────────────────────────────

  function buildModelProjectionSnapshot(): DesktopModelProjectionSnapshot {
    const model = options.selectedModel.value;
    return {
      selectedModelName: model?.name ?? "",
      selectedModelIconUrl: model?.icon_url ?? "",
      recommendedMode:
        model?.engine_hints.recommended_mode ?? "",
      confName: options.modelSyncState.confName,
      lastUpdated: options.modelSyncState.lastUpdated,
      runtimeSemanticAxisProfile: options.selectedSemanticAxisProfile.value
        ? cloneJson(options.selectedSemanticAxisProfile.value)
        : null,
      baseActionPreview: options.parameterActionPreview.value,
      motionTuningEffectiveExamples: options.adapter.state.motionTuningSamplesStatus.effectiveExamples
        .map((example) => cloneJson(example)),
    };
  }

  function publishModelProjectionSnapshot(): void {
    modelProjectionDebounce.flush();
    options.bridge.publishModelProjectionSnapshot(buildModelProjectionSnapshot());
  }

  watch(
    () => [
      options.modelSyncState.confName,
      options.modelSyncState.lastUpdated,
      options.selectedModel.value?.name ?? "",
      options.selectedModel.value?.icon_url ?? "",
      options.selectedModel.value?.engine_hints.recommended_mode ?? "",
      options.parameterActionPreview.value,
      options.selectedSemanticAxisProfile.value,
      options.adapter.state.motionTuningSamplesStatus.effectiveExamples,
    ],
    () => {
      modelProjectionDebounce.schedule(() => {
        options.bridge.publishModelProjectionSnapshot(buildModelProjectionSnapshot());
      });
    },
    { deep: true, immediate: true },
  );

  // ── Profile authoring snapshot ───────────────────────────────────

  watch(
    () => options.adapter.state.latestSemanticAxisProfileSaveResult,
    () => {
      profileDebounce.schedule(() => {
        options.bridge.publishProfileAuthoringSnapshot({
          latestSemanticAxisProfileSaveResult: options.adapter.state.latestSemanticAxisProfileSaveResult
            ? cloneJson(options.adapter.state.latestSemanticAxisProfileSaveResult)
            : null,
        });
      });
    },
    { deep: true, immediate: true },
  );

  onScopeDispose(() => {
    snapshotDebounce.flush();
    modelProjectionDebounce.flush();
    profileDebounce.flush();
  });

  return {
    publishModelProjectionSnapshot,
  };
}
