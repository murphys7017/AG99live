import type {
  DesktopMotionTuningEffectiveExample,
  DesktopMotionTuningSample,
  DesktopMotionTuningSamplesStatus,
} from "../../types/desktop.js";
import type {
  ProtocolEnvelope,
  SystemMotionTuningSampleDeletePayload,
  SystemMotionTuningSampleSavePayload,
  SystemMotionTuningSamplesStatePayload,
} from "../../types/protocol.js";
import {
  normalizeMotionTuningSamplePayload,
  serializeMotionTuningSample,
} from "../features/motionTuningPayload.js";

export interface AdapterMotionTuningState {
  motionTuningSamples: DesktopMotionTuningSample[];
  motionTuningSamplesStatus: DesktopMotionTuningSamplesStatus;
}

export interface AdapterMotionTuningDependencies {
  getSocket: () => WebSocket | null;
  buildMessageEnvelope: <TPayload>(
    type: string,
    payload: TPayload,
    turnId?: string | null,
  ) => ProtocolEnvelope<TPayload>;
  pushHistory: (role: "system" | "error", text: string) => void;
  setLastError: (message: string) => void;
  setStatusMessage: (message: string) => void;
}

export function useAdapterMotionTuning(
  state: AdapterMotionTuningState,
  deps: AdapterMotionTuningDependencies,
) {
  function validateSocket(): boolean {
    const socket = deps.getSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const error = "当前还没有连上适配器，无法操作动作调参样本。";
      deps.setLastError(error);
      deps.setStatusMessage(error);
      deps.pushHistory("error", error);
      return false;
    }
    return true;
  }

  function applyMotionTuningSamplesState(
    envelope: ProtocolEnvelope<unknown>,
  ): void {
    const payload = envelope.payload as SystemMotionTuningSamplesStatePayload;
    const samples = Array.isArray(payload.samples)
      ? payload.samples
        .map((sample) => normalizeMotionTuningSamplePayload(sample))
        .filter((sample): sample is DesktopMotionTuningSample => sample !== null)
      : [];
    const rootError = typeof payload.root_error === "string"
      ? payload.root_error.trim()
      : "";
    const loadError = typeof payload.load_error === "string"
      ? payload.load_error.trim()
      : "";
    const diagnostics = Array.isArray(payload.diagnostics)
      ? payload.diagnostics
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
      : [];
    const effectiveExamples = Array.isArray(payload.effective_examples)
      ? payload.effective_examples
        .map((item) => normalizeEffectiveExamplePayload(item))
        .filter((item): item is DesktopMotionTuningEffectiveExample => item !== null)
      : [];
    state.motionTuningSamples = samples;
    state.motionTuningSamplesStatus = {
      rootError,
      loadError,
      diagnostics,
      effectiveExamples,
    };
    if (rootError) {
      deps.setLastError(rootError);
      deps.setStatusMessage(`后端 runtime cache 根状态异常：${rootError}`);
      deps.pushHistory("error", `后端 runtime cache 根状态异常：${rootError}`);
      return;
    }
    if (loadError) {
      deps.setLastError(loadError);
      deps.setStatusMessage(`后端动作调参样本池加载失败：${loadError}`);
      deps.pushHistory("error", `后端动作调参样本池加载失败：${loadError}`);
      return;
    }
    const message = samples.length
      ? `已同步 ${samples.length} 个后端动作调参样本。`
      : "后端当前没有已保存的动作调参样本。";
    deps.setStatusMessage(message);
  }

  function saveMotionTuningSample(sample: DesktopMotionTuningSample): boolean {
    if (!validateSocket()) {
      return false;
    }

    deps.getSocket()!.send(
      JSON.stringify(
        deps.buildMessageEnvelope<SystemMotionTuningSampleSavePayload>(
          "system.motion_tuning_sample_save",
          {
            sample: serializeMotionTuningSample(sample),
          },
        ),
      ),
    );
    const message = `已提交动作调参样本保存请求：${sample.id}`;
    deps.setStatusMessage(message);
    deps.pushHistory("system", message);
    return true;
  }

  function deleteMotionTuningSample(sampleId: string): boolean {
    const normalizedSampleId = sampleId.trim();
    if (!normalizedSampleId) {
      const error = "动作调参样本 ID 为空，无法删除。";
      deps.setLastError(error);
      deps.setStatusMessage(error);
      deps.pushHistory("error", error);
      return false;
    }
    if (!validateSocket()) {
      return false;
    }

    deps.getSocket()!.send(
      JSON.stringify(
        deps.buildMessageEnvelope<SystemMotionTuningSampleDeletePayload>(
          "system.motion_tuning_sample_delete",
          {
            sample_id: normalizedSampleId,
          },
        ),
      ),
    );
    const message = `已提交动作调参样本删除请求：${normalizedSampleId}`;
    deps.setStatusMessage(message);
    deps.pushHistory("system", message);
    return true;
  }

  return {
    applyMotionTuningSamplesState,
    saveMotionTuningSample,
    deleteMotionTuningSample,
  };
}

function normalizeEffectiveExamplePayload(
  value: unknown,
): DesktopMotionTuningEffectiveExample | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    category?: unknown;
    input?: unknown;
    output?: unknown;
    source?: unknown;
    tags?: unknown;
  };
  if (!candidate.output || typeof candidate.output !== "object") {
    return null;
  }
  const output = candidate.output as {
    intent_tags?: unknown;
    duration_ms?: unknown;
    axis_levels?: unknown;
    motion_steps?: unknown;
    expression_resource_id?: unknown;
    motion_resource_id?: unknown;
  };
  const axisLevels = normalizeMotionTuningAxisRecord(output.axis_levels);
  const motionSteps = normalizeMotionTuningMotionSteps(output.motion_steps);
  if (!Object.keys(axisLevels).length && !motionSteps?.length) {
    return null;
  }
  return {
    category: typeof candidate.category === "string" ? candidate.category.trim() : "",
    input: typeof candidate.input === "string" ? candidate.input.trim() : "",
    output: {
      intentTags: Array.isArray(output.intent_tags)
        ? output.intent_tags
          .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
          .filter(Boolean)
        : [],
      durationHintMs: typeof output.duration_ms === "number" && Number.isFinite(output.duration_ms)
        ? output.duration_ms
        : null,
      axisLevels: Object.keys(axisLevels).length ? axisLevels : undefined,
      motionSteps,
      expressionResourceId: typeof output.expression_resource_id === "string"
        ? output.expression_resource_id.trim() || undefined
        : undefined,
      motionResourceId: typeof output.motion_resource_id === "string"
        ? output.motion_resource_id.trim() || undefined
        : undefined,
    },
    source: typeof candidate.source === "string" ? candidate.source.trim() : "",
    tags: Array.isArray(candidate.tags)
      ? candidate.tags.map((tag: unknown) => String(tag).trim()).filter(Boolean)
      : [],
  };
}

function normalizeMotionTuningMotionSteps(
  value: unknown,
): DesktopMotionTuningEffectiveExample["output"]["motionSteps"] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    return undefined;
  }
  const steps = value.map((item) => {
    if (!item || typeof item !== "object") {
      return null;
    }
    const candidate = item as {
      axis_levels?: unknown;
      duration_weight?: unknown;
    };
    const axisLevels = normalizeMotionTuningAxisRecord(candidate.axis_levels);
    const durationWeight = candidate.duration_weight;
    if (
      !Object.keys(axisLevels).length
      || typeof durationWeight !== "number"
      || !Number.isInteger(durationWeight)
      || durationWeight < 1
      || durationWeight > 3
    ) {
      return null;
    }
    return { axisLevels, durationWeight };
  });
  return steps.every((step) => step !== null)
    ? steps as NonNullable<DesktopMotionTuningEffectiveExample["output"]["motionSteps"]>
    : undefined;
}

function normalizeMotionTuningAxisRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim() || typeof item !== "number" || !Number.isFinite(item)) {
      continue;
    }
    result[key.trim()] = item;
  }
  return result;
}
