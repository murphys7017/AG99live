import { computed, reactive, readonly } from "vue";
import type {
  ComputedRef,
  DeepReadonly,
} from "vue";
import type {
  ModelSummary,
  ModelSyncInfo,
  ProtocolEnvelope,
  RuntimeCacheErrorsPayload,
  SystemModelSyncPayload,
} from "../../types/protocol.js";
import type { SemanticAxisProfile } from "../../types/semantic-axis-profile.js";

interface ModelSyncState {
  confName: string;
  lastUpdated: string;
  modelInfo: ModelSyncInfo | null;
  runtimeCacheErrors: RuntimeCacheErrorsPayload | null;
}

export interface ModelSyncInstance {
  state: DeepReadonly<ModelSyncState>;
  selectedModel: ComputedRef<ModelSummary | null>;
  selectedSemanticAxisProfile: ComputedRef<SemanticAxisProfile | null>;
  applyModelSyncMessage: (envelope: ProtocolEnvelope<SystemModelSyncPayload>) => void;
  resetModelSyncState: () => void;
}

export function createModelSync(): ModelSyncInstance {
  const state = reactive<ModelSyncState>({
    confName: "",
    lastUpdated: "",
    modelInfo: null,
    runtimeCacheErrors: null,
  });

  function resetModelSyncState(): void {
    state.confName = "";
    state.lastUpdated = "";
    state.modelInfo = null;
    state.runtimeCacheErrors = null;
  }

  function applyModelSyncMessage(
    envelope: ProtocolEnvelope<SystemModelSyncPayload>,
  ): void {
    if (envelope.type !== "system.model_sync") {
      return;
    }

    state.confName = envelope.payload.conf_name;
    state.lastUpdated = envelope.timestamp;
    state.modelInfo = envelope.payload.model_info;
    state.runtimeCacheErrors = envelope.payload.runtime_cache_errors;
  }

  const selectedModel = computed<ModelSummary | null>(() => {
    const modelInfo = state.modelInfo;
    if (!modelInfo) {
      return null;
    }
    return modelInfo.models.find((item) => item.name === modelInfo.selected_model) ?? null;
  });

  const selectedSemanticAxisProfile = computed(() => {
    return selectedModel.value?.semantic_axis_profile ?? null;
  });

  return {
    state: readonly(state),
    selectedModel,
    selectedSemanticAxisProfile,
    applyModelSyncMessage,
    resetModelSyncState,
  };
}
