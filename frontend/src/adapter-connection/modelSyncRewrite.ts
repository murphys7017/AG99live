import type {
  ModelSyncInfo,
  ProtocolEnvelope,
  RuntimeCacheErrorsPayload,
  SystemModelSyncPayload,
} from "../types/protocol";

export function rewriteModelSyncEnvelope(
  envelope: ProtocolEnvelope<SystemModelSyncPayload>,
  activeWsAddress: string,
): ProtocolEnvelope<SystemModelSyncPayload> {
  const modelInfo = rewriteModelInfo(envelope.payload.model_info, activeWsAddress);
  const runtimeCacheErrors = normalizeRuntimeCacheErrors(
    envelope.payload.runtime_cache_errors ?? modelInfo.runtime_cache_errors,
  );
  const modelInfoWithRuntimeCacheErrors: ModelSyncInfo = {
    ...modelInfo,
    runtime_cache_errors: runtimeCacheErrors,
  };
  return {
    ...envelope,
    payload: {
      ...envelope.payload,
      model_info: modelInfoWithRuntimeCacheErrors,
      runtime_cache_errors: runtimeCacheErrors,
    },
  };
}

function rewriteModelInfo(
  modelInfo: ModelSyncInfo,
  activeWsAddress: string,
): ModelSyncInfo {
  return {
    ...modelInfo,
    runtime_cache_errors: normalizeRuntimeCacheErrors(modelInfo.runtime_cache_errors),
    models: modelInfo.models.map((model) => ({
      ...model,
      model_url: rewriteHttpUrl(model.model_url, activeWsAddress),
      icon_url: rewriteHttpUrl(model.icon_url, activeWsAddress),
    })),
  };
}

function normalizeRuntimeCacheErrors(
  value: RuntimeCacheErrorsPayload | undefined,
): RuntimeCacheErrorsPayload | undefined {
  if (!value) {
    return undefined;
  }
  const normalized: RuntimeCacheErrorsPayload = {};
  const root = typeof value.root === "string" ? value.root.trim() : "";
  const scanCache = typeof value.scan_cache === "string" ? value.scan_cache.trim() : "";
  const actionFilterCache = typeof value.action_filter_cache === "string"
    ? value.action_filter_cache.trim()
    : "";
  const motionTuningSamples = typeof value.motion_tuning_samples === "string"
    ? value.motion_tuning_samples.trim()
    : "";
  if (root) {
    normalized.root = root;
  }
  if (scanCache) {
    normalized.scan_cache = scanCache;
  }
  if (actionFilterCache) {
    normalized.action_filter_cache = actionFilterCache;
  }
  if (motionTuningSamples) {
    normalized.motion_tuning_samples = motionTuningSamples;
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

export function rewriteSocketUrl(rawUrl: string, activeWsAddress: string): string {
  return rewriteUrlWithConnectedHost(rawUrl, activeWsAddress, "ws");
}

export function rewriteHttpUrl(
  rawUrl: string | null,
  activeWsAddress: string,
): string {
  if (!rawUrl) {
    return "";
  }
  return rewriteUrlWithConnectedHost(rawUrl, activeWsAddress, "http");
}

function rewriteUrlWithConnectedHost(
  rawUrl: string,
  activeWsAddress: string,
  family: "http" | "ws",
): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return trimmed;
  }

  const activeUrl = parseUrlSafely(activeWsAddress);
  const targetUrl = parseUrlSafely(trimmed);
  if (!activeUrl || !targetUrl) {
    return trimmed;
  }

  const rewritten = new URL(targetUrl.toString());
  rewritten.hostname = activeUrl.hostname;
  rewritten.protocol =
    family === "http"
      ? activeUrl.protocol === "wss:"
        ? "https:"
        : "http:"
      : activeUrl.protocol === "https:"
        ? "wss:"
        : activeUrl.protocol === "http:"
          ? "ws:"
          : activeUrl.protocol;

  if (activeUrl.username) {
    rewritten.username = activeUrl.username;
  }
  if (activeUrl.password) {
    rewritten.password = activeUrl.password;
  }

  return rewritten.toString().replace(/\/$/, "");
}

function parseUrlSafely(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch (_error) {
    return null;
  }
}
