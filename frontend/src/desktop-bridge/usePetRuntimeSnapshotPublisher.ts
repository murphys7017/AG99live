import { watch, type ComputedRef, type Ref } from "vue";
import { cloneModelEngineSettings, type ModelEngineSettings } from "../model-engine/settings";
import {
  cloneLive2dPresentationSettings,
  type Live2dPresentationSettings,
} from "../live2d-renderer/settings";
import type {
  DesktopBaseActionPreview,
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopHistoryEntry,
  DesktopMicrophoneDevice,
  DesktopModelProjectionSnapshot,
  DesktopMotionPlaybackRecord,
  DesktopPttKeyBinding,
  DesktopPttHookStatus,
  DesktopRuntimeSnapshot,
  DesktopSemanticAxisProfileSaveResult,
  DesktopMotionTuningSamplesStatus,
} from "../types/desktop";
import type { BilibiliLiveStatus } from "../types/bilibili-live";
import type { ModelSummary, SystemServerInfoPayload } from "../types/protocol";
import type { SemanticAxisProfile } from "../types/semantic-axis-profile";
import type { ModelSyncInstance } from "../adapter-connection/model-sync/useModelSync";
import {
  buildAdapterRuntimeProjection,
  buildDesktopRuntimeSnapshot,
} from "./projection.js";
import {
  nextSnapshotRevision,
  getPublisherId,
} from "./snapshot/runtimeSnapshot.js";
import { cloneJson } from "../utils/cloneJson.js";

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
    readonly pttKeyBinding: DesktopPttKeyBinding;
    readonly pttHookStatus: DesktopPttHookStatus;
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
  publishSnapshot: (snapshot: DesktopRuntimeSnapshot) => void;
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
  modelSyncState: ModelSyncInstance["state"];
  selectedModel: Ref<ModelSummary | null>;
  selectedSemanticAxisProfile: Ref<SemanticAxisProfile | null>;
  motionEngineSettings: ModelEngineSettings;
  live2dPresentationSettings: Live2dPresentationSettings;
  motionPlaybackRecords: { readonly value: readonly DesktopMotionPlaybackRecord[] };
  parameterActionPreview: ComputedRef<DesktopBaseActionPreview | null>;
  connectionState: ComputedRef<string>;
  connectionLabel: ComputedRef<string>;
  stageMessage: ComputedRef<string>;
  aiState: ComputedRef<string>;
  bilibiliLiveStatus: () => BilibiliLiveStatus;
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

export interface PetRuntimeSnapshotPublisher {
  publishRuntimeSnapshot: () => void;
  publishMotionTuningSamples: () => void;
  publishModelProjectionSnapshot: () => void;
  dispose: () => void;
}

export function createPetRuntimeSnapshotPublisher(
  options: PetRuntimeSnapshotPublisherOptions,
): PetRuntimeSnapshotPublisher {
  const snapshotDebounce = createDebounce();
  const modelProjectionDebounce = createDebounce();
  const profileDebounce = createDebounce();
  let lastPublishedMotionRecordId: string | null = null;
  function buildRuntimeSnapshotInput() {
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
        pttKeyBinding: a.pttKeyBinding,
        pttHookStatus: a.pttHookStatus,
        historyEntries: [...a.historyEntries],
        backendHistorySummaries: [...a.backendHistorySummaries],
        backendHistoryEntries: [...a.backendHistoryEntries],
        activeBackendHistoryUid: a.activeBackendHistoryUid,
        backendHistoryLoading: a.backendHistoryLoading,
        backendHistoryStatusMessage: a.backendHistoryStatusMessage,
        bilibiliLiveStatus: options.bilibiliLiveStatus(),
      });

      return {
        adapter: adapterProjection,
        motionEngineSettings: cloneModelEngineSettings(options.motionEngineSettings),
        live2dPresentationSettings: cloneLive2dPresentationSettings(
          options.live2dPresentationSettings,
        ),
        motionPlaybackRecords: options.motionPlaybackRecords.value.map((record) =>
          cloneJson(record),
        ) as DesktopMotionPlaybackRecord[],
        connectionState: options.connectionState.value,
        connectionLabel: options.connectionLabel.value,
        stageMessage: options.stageMessage.value,
        aiState: options.aiState.value,
        confName: options.modelSyncState.confName,
        lastUpdated: options.modelSyncState.lastUpdated,
      };
  }

  function publishSnapshotWithRevision(input: ReturnType<typeof buildRuntimeSnapshotInput>): void {
    const snap = buildDesktopRuntimeSnapshot(input);
    const latestMotionRecord = snap.motionPlaybackRecords[0] ?? null;
    if (latestMotionRecord?.id !== lastPublishedMotionRecordId) {
      console.info("[MotionLab] runtime snapshot motion history updated.", {
        recordCount: snap.motionPlaybackRecords.length,
        latestRecordId: latestMotionRecord?.id ?? null,
        latestTurnId: latestMotionRecord?.turnId ?? null,
        latestMessageId: latestMotionRecord?.messageId ?? null,
      });
      lastPublishedMotionRecordId = latestMotionRecord?.id ?? null;
    }
    options.bridge.publishSnapshot({
      ...snap,
      _publisherId: getPublisherId(),
      _revision: nextSnapshotRevision(),
    });
  }

  const stopRuntimeSnapshotWatch = watch(
    buildRuntimeSnapshotInput,
    (input) => {
      snapshotDebounce.schedule(() => {
        publishSnapshotWithRevision(input);
      });
    },
    { deep: true, immediate: true },
  );

  function publishRuntimeSnapshot(): void {
    snapshotDebounce.cancel();
    publishSnapshotWithRevision(buildRuntimeSnapshotInput());
  }

  function publishMotionTuningSamples(): void {
    options.bridge.publishMotionTuningSamples(
      options.adapter.state.motionTuningSamples.map((sample) => cloneJson(sample)),
      cloneJson(options.adapter.state.motionTuningSamplesStatus) as DesktopMotionTuningSamplesStatus,
    );
  }

  // ── Runtime snapshot ────────────────────────────────────────────
  // Build adapter + session projections from source state,
  // then assemble the final snapshot.

  // ── Motion tuning projection ────────────────────────────────────

  const stopMotionTuningWatch = watch(
    () => ({
      samples: options.adapter.state.motionTuningSamples,
      status: options.adapter.state.motionTuningSamplesStatus,
    }),
    () => {
      snapshotDebounce.schedule(() => {
        publishMotionTuningSamples();
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
      baseActionPreview: options.parameterActionPreview.value
        ? cloneJson(options.parameterActionPreview.value)
        : null,
      motionTuningEffectiveExamples: options.adapter.state.motionTuningSamplesStatus.effectiveExamples
        .map((example) => cloneJson(example)),
    };
  }

  function publishModelProjectionSnapshot(): void {
    modelProjectionDebounce.flush();
    options.bridge.publishModelProjectionSnapshot(buildModelProjectionSnapshot());
  }

  const stopModelProjectionWatch = watch(
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

  const stopProfileWatch = watch(
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

  function dispose(): void {
    stopRuntimeSnapshotWatch();
    stopMotionTuningWatch();
    stopModelProjectionWatch();
    stopProfileWatch();
    snapshotDebounce.flush();
    modelProjectionDebounce.flush();
    profileDebounce.flush();
  }

  return {
    publishRuntimeSnapshot,
    publishMotionTuningSamples,
    publishModelProjectionSnapshot,
    dispose,
  };
}
