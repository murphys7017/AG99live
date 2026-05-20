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
    input?: unknown;
    output?: unknown;
    source?: unknown;
    tags?: unknown;
  };
  if (!candidate.output || typeof candidate.output !== "object") {
    return null;
  }
  const output = candidate.output as {
    emotion?: unknown;
    mode?: unknown;
    duration_ms?: unknown;
    axes?: unknown;
  };
  return {
    input: typeof candidate.input === "string" ? candidate.input.trim() : "",
    output: {
      emotion: typeof output.emotion === "string" ? output.emotion.trim() : "",
      mode: typeof output.mode === "string" ? output.mode.trim() : "",
      durationMs: typeof output.duration_ms === "number" && Number.isFinite(output.duration_ms)
        ? output.duration_ms
        : null,
      axes: normalizeMotionTuningAxisRecord(output.axes),
    },
    source: typeof candidate.source === "string" ? candidate.source.trim() : "",
    tags: Array.isArray(candidate.tags)
      ? candidate.tags.map((tag: unknown) => String(tag).trim()).filter(Boolean)
      : [],
  };
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
