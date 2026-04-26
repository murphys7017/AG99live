import { computed, reactive, readonly } from "vue";
import type {
  ModelSummary,
  ModelSyncInfo,
  ProtocolEnvelope,
  SystemModelSyncPayload,
} from "../types/protocol";

const state = reactive({
  sessionId: "",
  confName: "",
  lastUpdated: "",
  modelInfo: null as ModelSyncInfo | null,
});

function resetModelSyncState(): void {
  state.sessionId = "";
  state.confName = "";
  state.lastUpdated = "";
  state.modelInfo = null;
}

function applyModelSyncMessage(
  envelope: ProtocolEnvelope<SystemModelSyncPayload>,
): void {
  if (envelope.type !== "system.model_sync") {
    return;
  }

  state.sessionId = envelope.session_id;
  state.confName = envelope.payload.conf_name;
  state.lastUpdated = envelope.timestamp;
  state.modelInfo = envelope.payload.model_info;
}

function applyUnknownMessage(raw: unknown): void {
  if (!raw || typeof raw !== "object") {
    return;
  }

  const candidate = raw as Partial<ProtocolEnvelope<SystemModelSyncPayload>>;
  if (candidate.type !== "system.model_sync" || !candidate.payload) {
    return;
  }

  applyModelSyncMessage(candidate as ProtocolEnvelope<SystemModelSyncPayload>);
}

const selectedModel = computed<ModelSummary | null>(() => {
  const modelInfo = state.modelInfo;
  if (!modelInfo) {
    return null;
  }
  return (
    modelInfo.models.find((item) => item.name === modelInfo.selected_model) ??
    modelInfo.models[0] ??
    null
  );
});

const selectedSemanticAxisProfile = computed(() => {
  return selectedModel.value?.semantic_axis_profile ?? null;
});

if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    applyUnknownMessage(event.data);
  });

  (
    window as Window & {
      __AG99LIVE_DEVTOOLS__?: { pushProtocolMessage: (payload: unknown) => void };
    }
  ).__AG99LIVE_DEVTOOLS__ = {
    pushProtocolMessage: applyUnknownMessage,
  };
}

export function useModelSync() {
  return {
    state: readonly(state),
    selectedModel,
    selectedSemanticAxisProfile,
    applyModelSyncMessage,
    applyUnknownMessage,
    resetModelSyncState,
  };
}
