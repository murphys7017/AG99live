import { computed, onScopeDispose, reactive, readonly } from "vue";
import type {
  ComputedRef,
  DeepReadonly,
} from "vue";
import type {
  ModelSummary,
  ModelSyncInfo,
  ProtocolEnvelope,
  SystemModelSyncPayload,
} from "../../types/protocol.js";
import type { SemanticAxisProfile } from "../../types/semantic-axis-profile.js";
import { parseInboundEnvelopeObject } from "../inbound/inboundProtocol.js";
import { parseSystemModelSyncPayload } from "../inbound/inboundPayloads.js";

interface ModelSyncState {
  confName: string;
  lastUpdated: string;
  modelInfo: ModelSyncInfo | null;
}

export interface ModelSyncInstance {
  state: DeepReadonly<ModelSyncState>;
  selectedModel: ComputedRef<ModelSummary | null>;
  selectedSemanticAxisProfile: ComputedRef<SemanticAxisProfile | null>;
  applyModelSyncMessage: (envelope: ProtocolEnvelope<SystemModelSyncPayload>) => void;
  applyUnknownMessage: (raw: unknown) => void;
  resetModelSyncState: () => void;
}

export function createModelSync(): ModelSyncInstance {
  const state = reactive<ModelSyncState>({
    confName: "",
    lastUpdated: "",
    modelInfo: null,
  });

  function resetModelSyncState(): void {
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

    state.confName = envelope.payload.conf_name;
    state.lastUpdated = envelope.timestamp;
    state.modelInfo = envelope.payload.model_info;
  }

  function applyUnknownMessage(raw: unknown): void {
    const parsed = parseInboundEnvelopeObject(raw);
    if (!parsed.ok) {
      return;
    }
    if (parsed.envelope.type !== "system.model_sync") {
      return;
    }
    const payload = parseSystemModelSyncPayload(parsed.envelope);
    if (!payload.ok) {
      console.warn("[ModelSync] rejected malformed model_sync from window/devtools.", payload.error);
      return;
    }
    applyModelSyncMessage({
      ...parsed.envelope,
      payload: payload.payload,
    });
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
    applyUnknownMessage,
    resetModelSyncState,
  };
}

export function attachModelSyncWindowBridge(modelSync: ModelSyncInstance): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  function onWindowMessage(event: MessageEvent): void {
    modelSync.applyUnknownMessage(event.data);
  }

  window.addEventListener("message", onWindowMessage);

  const devtoolsMount = window as Window & {
    __AG99LIVE_DEVTOOLS__?: { pushProtocolMessage: (payload: unknown) => void };
  };
  devtoolsMount.__AG99LIVE_DEVTOOLS__ = {
    pushProtocolMessage: modelSync.applyUnknownMessage,
  };

  return () => {
    window.removeEventListener("message", onWindowMessage);
    delete devtoolsMount.__AG99LIVE_DEVTOOLS__;
  };
}

export function useModelSync(modelSync: ModelSyncInstance): ModelSyncInstance {
  const cleanup = attachModelSyncWindowBridge(modelSync);

  onScopeDispose(() => {
    cleanup();
  });

  return modelSync;
}
