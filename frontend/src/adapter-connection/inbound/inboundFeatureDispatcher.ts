import type {
  ProtocolEnvelope,
  SystemModelSyncPayload,
  SystemSemanticAxisProfileSavedPayload,
  SystemSemanticAxisProfileSaveFailedPayload,
} from "../../types/protocol.js";
import type { InboundAdapterEvent } from "./inboundEvents.js";

export interface InboundFeatureDispatchState {
  statusMessage: string;
  lastError: string;
  latestSemanticAxisProfileSaveResult: unknown;
}

export interface InboundFeatureDispatchDeps {
  state: InboundFeatureDispatchState;
  pushHistory: (role: string, text: string) => void;
  modelSyncAdapter: { applyUnknownMessage: (envelope: ProtocolEnvelope<unknown>) => void } | null;
  historyAdapter: {
    applyHistoryList: (envelope: ProtocolEnvelope<unknown>) => void;
    applyHistoryCreated: (envelope: ProtocolEnvelope<unknown>) => void;
    applyHistoryData: (envelope: ProtocolEnvelope<unknown>) => void;
    applyHistoryDeleted: (envelope: ProtocolEnvelope<unknown>) => void;
  } | null;
  motionTuningAdapter: { applyMotionTuningSamplesState: (envelope: ProtocolEnvelope<unknown>) => void } | null;
  rewriteModelSyncEnvelope: (envelope: ProtocolEnvelope<SystemModelSyncPayload>) => ProtocolEnvelope<SystemModelSyncPayload>;
}

type InboundFeatureEvent = Extract<
  InboundAdapterEvent,
  | { kind: "model_sync" }
  | { kind: "semantic_axis_profile_saved" }
  | { kind: "semantic_axis_profile_save_failed" }
  | { kind: "motion_tuning_samples_state" }
  | { kind: "history_list" }
  | { kind: "history_created" }
  | { kind: "history_data" }
  | { kind: "history_deleted" }
>;

export function dispatchInboundFeatureEvent(
  deps: InboundFeatureDispatchDeps,
  event: InboundFeatureEvent,
): void {
  switch (event.kind) {
    case "model_sync":
      deps.modelSyncAdapter?.applyUnknownMessage(
        deps.rewriteModelSyncEnvelope(event.envelope),
      );
      deps.state.statusMessage = "模型能力已同步。";
      deps.pushHistory("system", deps.state.statusMessage);
      return;
    case "semantic_axis_profile_saved":
      applySemanticAxisProfileSaved(deps, event.envelope);
      return;
    case "semantic_axis_profile_save_failed":
      applySemanticAxisProfileSaveFailed(deps, event.envelope);
      return;
    case "motion_tuning_samples_state":
      deps.motionTuningAdapter?.applyMotionTuningSamplesState(event.envelope);
      return;
    case "history_list":
      deps.historyAdapter?.applyHistoryList(event.envelope);
      return;
    case "history_created":
      deps.historyAdapter?.applyHistoryCreated(event.envelope);
      return;
    case "history_data":
      deps.historyAdapter?.applyHistoryData(event.envelope);
      return;
    case "history_deleted":
      deps.historyAdapter?.applyHistoryDeleted(event.envelope);
      return;
  }
}

function applySemanticAxisProfileSaved(
  deps: InboundFeatureDispatchDeps,
  envelope: ProtocolEnvelope<SystemSemanticAxisProfileSavedPayload>,
): void {
  const s = deps.state;
  s.latestSemanticAxisProfileSaveResult = {
    requestId: envelope.payload.request_id,
    ok: true,
    modelName: envelope.payload.model_name,
    profileId: envelope.payload.profile_id,
    revision: envelope.payload.revision,
    sourceHash: envelope.payload.source_hash,
    savedAt: envelope.payload.saved_at,
    receivedAt: new Date().toISOString(),
  };
  s.lastError = "";
  s.statusMessage = `主轴配置已保存到 revision ${envelope.payload.revision}。`;
  deps.pushHistory("system", s.statusMessage);
}

function applySemanticAxisProfileSaveFailed(
  deps: InboundFeatureDispatchDeps,
  envelope: ProtocolEnvelope<SystemSemanticAxisProfileSaveFailedPayload>,
): void {
  const s = deps.state;
  s.latestSemanticAxisProfileSaveResult = {
    requestId: envelope.payload.request_id,
    ok: false,
    modelName: envelope.payload.model_name,
    profileId: envelope.payload.profile_id,
    expectedRevision: envelope.payload.expected_revision,
    errorCode: envelope.payload.error_code,
    message: envelope.payload.message,
    receivedAt: new Date().toISOString(),
  };
  s.lastError = envelope.payload.message;
  s.statusMessage = `主轴配置保存失败：${envelope.payload.message}`;
  deps.pushHistory("error", s.statusMessage);
}
