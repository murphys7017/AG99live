import { computed, onScopeDispose, reactive, readonly } from "vue";
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

let initialized = false;

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

function ensureInitialized(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  if (typeof window === "undefined") {
    return () => {};
  }

  function onWindowMessage(event: MessageEvent): void {
    applyUnknownMessage(event.data);
  }

  window.addEventListener("message", onWindowMessage);

  const devtoolsMount = window as Window & {
    __AG99LIVE_DEVTOOLS__?: { pushProtocolMessage: (payload: unknown) => void };
  };
  devtoolsMount.__AG99LIVE_DEVTOOLS__ = {
    pushProtocolMessage: applyUnknownMessage,
  };

  return () => {
    window.removeEventListener("message", onWindowMessage);
    delete devtoolsMount.__AG99LIVE_DEVTOOLS__;
    initialized = false;
  };
}

export function useModelSync() {
  const cleanup = ensureInitialized();

  onScopeDispose(() => {
    cleanup();
  });

  return {
    state: readonly(state),
    selectedModel,
    selectedSemanticAxisProfile,
    applyModelSyncMessage,
    applyUnknownMessage,
    resetModelSyncState,
  };
}
