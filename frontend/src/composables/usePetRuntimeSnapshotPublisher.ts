import { onScopeDispose, watch, type ComputedRef, type Ref } from "vue";
import { cloneModelEngineSettings, type ModelEngineSettings } from "../model-engine/settings";
import { cloneJson } from "../utils/cloneJson";
import type {
  DesktopBaseActionPreview,
  DesktopMotionPlaybackRecord,
} from "../types/desktop";
import type { ModelSummary } from "../types/protocol";
import type { SemanticAxisProfile } from "../types/semantic-axis-profile";
import type { useAdapterConnection } from "./useAdapterConnection";
import type { useDesktopBridge } from "./useDesktopBridge";
import type { useModelSync } from "./useModelSync";

type AdapterConnection = ReturnType<typeof useAdapterConnection>;
type DesktopBridge = ReturnType<typeof useDesktopBridge>;
type ModelSync = ReturnType<typeof useModelSync>;

const SNAPSHOT_DEBOUNCE_MS = 60;

interface PetRuntimeSnapshotPublisherOptions {
  adapter: AdapterConnection;
  bridge: DesktopBridge;
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
}

function serializeAxisIntensityScale(axisIntensityScale: Record<string, number>): string {
  return JSON.stringify(
    Object.entries(axisIntensityScale).sort(([left], [right]) =>
      left.localeCompare(right)),
  );
}

function createTrailingDebounce(): {
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
): void {
  const snapshotDebounce = createTrailingDebounce();
  const profileDebounce = createTrailingDebounce();

  watch(
    () => ({
      samples: options.adapter.state.motionTuningSamples,
      status: options.adapter.state.motionTuningSamplesStatus,
    }),
    ({ samples, status }) => {
      snapshotDebounce.schedule(() => {
        options.bridge.publishMotionTuningSamples(samples, status);
      });
    },
    { deep: true, immediate: true },
  );

  watch(
    () => [
      options.ambientMotionEnabled.value,
      options.adapter.state.address,
      options.adapter.state.desktopScreenshotOnSendEnabled,
      options.adapter.state.status,
      options.adapter.state.statusMessage,
      options.adapter.state.sessionId,
      options.adapter.state.serverInfo?.ws_url ?? "",
      options.adapter.state.serverInfo?.http_base_url ?? "",
      options.adapter.state.lastAssistantText,
      options.adapter.state.lastTranscription,
      options.adapter.state.lastImageCount,
      options.adapter.state.currentTurnId,
      options.adapter.state.micRequested,
      options.adapter.state.micCapturing,
      options.adapter.state.isPlayingAudio,
      options.adapter.state.historyEntries,
      options.adapter.state.backendHistorySummaries,
      options.adapter.state.backendHistoryEntries,
      options.adapter.state.activeBackendHistoryUid,
      options.adapter.state.backendHistoryLoading,
      options.adapter.state.backendHistoryStatusMessage,
      options.modelSyncState.confName,
      options.modelSyncState.lastUpdated,
      options.selectedModel.value?.name ?? "",
      options.selectedModel.value?.icon_url ?? "",
      options.selectedModel.value?.engine_hints.recommended_mode ?? "",
      options.parameterActionPreview.value,
      options.stageMessage.value,
      options.motionEngineSettings.motionIntensityScale,
      serializeAxisIntensityScale(options.motionEngineSettings.axisIntensityScale),
      options.motionPlaybackRecords.value,
      options.selectedSemanticAxisProfile.value,
    ],
    () => {
      snapshotDebounce.schedule(() => {
        options.bridge.publishSnapshot({
          adapterAddress: options.adapter.state.address,
          desktopScreenshotOnSendEnabled: options.adapter.state.desktopScreenshotOnSendEnabled,
          ambientMotionEnabled: options.ambientMotionEnabled.value,
          motionEngineSettings: cloneModelEngineSettings(options.motionEngineSettings),
          motionPlaybackRecords: options.motionPlaybackRecords.value.map((record) =>
            cloneJson(record)),
          connectionState: options.connectionState.value,
          connectionLabel: options.connectionLabel.value,
          connectionStatusMessage: options.adapter.state.statusMessage,
          aiState: options.aiState.value,
          micRequested: options.adapter.state.micRequested,
          micCapturing: options.adapter.state.micCapturing,
          audioPlaying: options.adapter.state.isPlayingAudio,
          sessionId: options.adapter.state.sessionId || options.modelSyncState.sessionId,
          confName: options.modelSyncState.confName,
          lastUpdated: options.modelSyncState.lastUpdated,
          selectedModelName: options.selectedModel.value?.name ?? "",
          selectedModelIconUrl: options.selectedModel.value?.icon_url ?? "",
          recommendedMode:
            options.selectedModel.value?.engine_hints.recommended_mode ?? "",
          serverWsUrl: options.adapter.state.serverInfo?.ws_url ?? "",
          httpBaseUrl: options.adapter.state.serverInfo?.http_base_url ?? "",
          stageMessage: options.stageMessage.value,
          lastSentText: options.adapter.state.historyEntries
            .slice()
            .reverse()
            .find((entry) => entry.role === "user")?.text ?? "",
          lastAssistantText: options.adapter.state.lastAssistantText,
          lastTranscription: options.adapter.state.lastTranscription,
          lastImageCount: options.adapter.state.lastImageCount,
          historyEntries: [...options.adapter.state.historyEntries],
          backendHistorySummaries: options.adapter.state.backendHistorySummaries.map((summary) =>
            cloneJson(summary)),
          backendHistoryEntries: options.adapter.state.backendHistoryEntries.map((entry) =>
            cloneJson(entry)),
          activeBackendHistoryUid: options.adapter.state.activeBackendHistoryUid,
          backendHistoryLoading: options.adapter.state.backendHistoryLoading,
          backendHistoryStatusMessage: options.adapter.state.backendHistoryStatusMessage,
          runtimeSemanticAxisProfile: options.selectedSemanticAxisProfile.value
            ? cloneJson(options.selectedSemanticAxisProfile.value)
            : null,
          baseActionPreview: options.parameterActionPreview.value,
        });
      });
    },
    { deep: true, immediate: true },
  );

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
    profileDebounce.flush();
  });
}
