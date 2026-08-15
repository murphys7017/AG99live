import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type Ref,
} from "vue";
import type { ModelSummary } from "../types/protocol";
import {
  selectLive2dRuntimeEffectsSettings,
  type Live2dPresentationSettings,
} from "./settings";

type RenderStatus = "idle" | "loading" | "ready" | "error";

const LIVE2D_CORE_SCRIPT_ID = "ag99live-live2d-core";

let live2dCorePromise: Promise<void> | null = null;

function parseModelUrl(url: string): {
  baseUrl: string;
  modelDir: string;
  modelFileName: string;
} {
  const urlObject = new URL(url);
  const pathSegments = urlObject.pathname.split("/").filter(Boolean);
  if (pathSegments.length < 2) {
    throw new Error(`Invalid model URL: ${url}`);
  }

  const modelFile = pathSegments[pathSegments.length - 1];
  const modelDir = pathSegments[pathSegments.length - 2];
  const modelFileName = modelFile.replace(/\.model3\.json$/i, "");
  const basePath = pathSegments.slice(0, -2).join("/");
  const baseUrl = `${urlObject.protocol}//${urlObject.host}/${basePath}/`;

  return {
    baseUrl,
    modelDir,
    modelFileName,
  };
}

function ensureLive2DCoreLoaded(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }
  if (window.Live2DCubismCore) {
    return Promise.resolve();
  }
  if (live2dCorePromise) {
    return live2dCorePromise;
  }

  live2dCorePromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.getElementById(
      LIVE2D_CORE_SCRIPT_ID,
    ) as HTMLScriptElement | null;

    if (existingScript?.dataset.loaded === "true") {
      resolve();
      return;
    }

    const handleResolve = () => {
      if (existingScript) {
        existingScript.dataset.loaded = "true";
      }
      resolve();
    };
    const handleReject = () => reject(new Error("Failed to load Live2D Cubism Core."));

    if (existingScript) {
      existingScript.addEventListener("load", handleResolve, { once: true });
      existingScript.addEventListener("error", handleReject, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = LIVE2D_CORE_SCRIPT_ID;
    script.async = true;
    script.src = `${import.meta.env.BASE_URL}libs/live2dcubismcore.js`;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    }, { once: true });
    script.addEventListener("error", handleReject, { once: true });
    document.head.appendChild(script);
  });

  return live2dCorePromise;
}

export function useLive2dRenderer(
  selectedModel: Ref<ModelSummary | null>,
  settings: Ref<Live2dPresentationSettings>,
) {
  const containerRef = ref<HTMLDivElement | null>(null);
  const canvasRef = ref<HTMLCanvasElement | null>(null);
  const renderStatus = ref<RenderStatus>("idle");
  const renderError = ref("");
  const mountedModelUrl = shallowRef("");
  const resizeLive2D = shallowRef<null | (() => void)>(null);
  let resizeObserver: ResizeObserver | null = null;
  let disposeForceRedrawListener: (() => void) | null = null;
  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;
  let modelLoadQueue: Promise<void> = Promise.resolve();
  let modelRequestVersion = 0;
  let activeLoadVersion: number | null = null;
  let cancelActiveModelLoad: ((reason?: string) => boolean) | null = null;
  let rendererLifecycleStarted = false;
  let disposed = false;

  const statusLabel = computed(() => {
    if (renderStatus.value === "ready") {
      return "Live2D Ready";
    }
    if (renderStatus.value === "loading") {
      return "Live2D Loading";
    }
    if (renderStatus.value === "error") {
      return "Live2D Error";
    }
    return "Live2D Idle";
  });

  function isPetWindowDragging(): boolean {
    return Boolean(
      (window as Window & { __ag99PetWindowDragging?: boolean }).__ag99PetWindowDragging,
    );
  }

  function syncCanvasSize(): boolean {
    const container = containerRef.value;
    const canvas = canvasRef.value;
    if (!container || !canvas) {
      return false;
    }

    const rect = container.getBoundingClientRect();
    const width = Math.max(rect.width, 1);
    const height = Math.max(rect.height, 1);
    const dprCap = settings.value.renderDprCap;
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, dprCap));
    const nextCanvasWidth = Math.round(width * dpr);
    const nextCanvasHeight = Math.round(height * dpr);
    const changed =
      nextCanvasWidth !== lastCanvasWidth
      || nextCanvasHeight !== lastCanvasHeight
      || canvas.width !== nextCanvasWidth
      || canvas.height !== nextCanvasHeight;

    if (changed) {
      canvas.width = nextCanvasWidth;
      canvas.height = nextCanvasHeight;
      lastCanvasWidth = nextCanvasWidth;
      lastCanvasHeight = nextCanvasHeight;
    }

    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    return changed;
  }

  function forceLive2DRedraw() {
    if (syncCanvasSize()) {
      resizeLive2D.value?.();
    }

    window.requestAnimationFrame(() => {
      if (syncCanvasSize()) {
        resizeLive2D.value?.();
      }
    });
  }

  function clearMountedRendererState(): void {
    mountedModelUrl.value = "";
    resizeLive2D.value = null;
  }

  async function releaseRenderer(reason: string): Promise<void> {
    const { releaseLive2D } = await import("@cubismsdksamples/main");
    releaseLive2D(reason);
    rendererLifecycleStarted = false;
    clearMountedRendererState();
  }

  function isCurrentModelRequest(requestVersion: number, modelUrl: string): boolean {
    return (
      !disposed
      && requestVersion === modelRequestVersion
      && selectedModel.value?.model_url === modelUrl
    );
  }

  async function loadModel(model: ModelSummary, requestVersion: number): Promise<void> {
    renderStatus.value = "loading";
    renderError.value = "";

    try {
      await nextTick();
      if (!isCurrentModelRequest(requestVersion, model.model_url)) {
        return;
      }
      syncCanvasSize();
      await ensureLive2DCoreLoaded();

      const [
        { cancelLive2DInitialization, initializeLive2D },
        { updateModelConfig, applyRuntimeEffectsSettings },
        { LAppDelegate },
      ] =
        await Promise.all([
          import("@cubismsdksamples/main"),
          import("@cubismsdksamples/lappdefine"),
          import("@cubismsdksamples/lappdelegate"),
        ]);

      if (!isCurrentModelRequest(requestVersion, model.model_url)) {
        return;
      }
      const { baseUrl, modelDir, modelFileName } = parseModelUrl(model.model_url);
      applyRuntimeEffectsSettings(
        selectLive2dRuntimeEffectsSettings(settings.value, model),
      );
      updateModelConfig(baseUrl, modelDir, modelFileName);
      activeLoadVersion = requestVersion;
      cancelActiveModelLoad = cancelLive2DInitialization;
      rendererLifecycleStarted = true;
      try {
        await initializeLive2D();
      } finally {
        if (activeLoadVersion === requestVersion) {
          activeLoadVersion = null;
          cancelActiveModelLoad = null;
        }
      }
      await nextTick();
      if (!isCurrentModelRequest(requestVersion, model.model_url)) {
        return;
      }
      const didResizeCanvas = syncCanvasSize();
      resizeLive2D.value = () => LAppDelegate.getInstance().onResize();
      if (didResizeCanvas) {
        resizeLive2D.value();
      }

      mountedModelUrl.value = model.model_url;
      renderStatus.value = "ready";
    } catch (error) {
      try {
        await releaseRenderer("live2d_model_initialization_failed");
      } catch (releaseError) {
        console.error("[AG99live] Failed to release Live2D renderer after initialization failure", releaseError);
      }
      if (!isCurrentModelRequest(requestVersion, model.model_url)) {
        return;
      }
      console.error("[AG99live] Failed to initialize Live2D renderer", error);
      renderError.value =
        error instanceof Error ? error.message : "Unknown Live2D initialization error.";
      renderStatus.value = "error";
    }
  }

  function queueModelRequest(model: ModelSummary | null): void {
    const requestVersion = ++modelRequestVersion;
    const modelUrl = model?.model_url ?? "";
    if (activeLoadVersion !== null) {
      cancelActiveModelLoad?.("live2d_model_load_replaced");
    }

    if (model) {
      renderStatus.value = "loading";
      renderError.value = "";
    } else {
      renderStatus.value = "idle";
      renderError.value = "";
      if (!rendererLifecycleStarted && activeLoadVersion === null) {
        clearMountedRendererState();
        return;
      }
    }

    modelLoadQueue = modelLoadQueue.then(async () => {
      if (disposed || requestVersion !== modelRequestVersion) {
        return;
      }
      if (!model) {
        await releaseRenderer("live2d_model_selection_cleared");
        return;
      }
      if (modelUrl === mountedModelUrl.value && renderStatus.value === "ready") {
        return;
      }
      await loadModel(model, requestVersion);
    }).catch((error) => {
      if (disposed || requestVersion !== modelRequestVersion) {
        return;
      }
      console.error("[AG99live] Live2D model transition failed", error);
      clearMountedRendererState();
      renderError.value =
        error instanceof Error ? error.message : "Unknown Live2D model transition error.";
      renderStatus.value = "error";
    });
  }

  onMounted(() => {
    resizeObserver = new ResizeObserver(() => {
      if (isPetWindowDragging()) {
        return;
      }

      if (syncCanvasSize()) {
        resizeLive2D.value?.();
      }
    });

    if (containerRef.value) {
      resizeObserver.observe(containerRef.value);
    }

    disposeForceRedrawListener =
      window.ag99desktop?.onForceRedraw(() => {
        void nextTick().then(() => {
          forceLive2DRedraw();
        });
      }) ?? null;
  });

  watch(
    () => selectedModel.value?.model_url ?? "",
    (nextUrl) => {
      if (nextUrl === mountedModelUrl.value && renderStatus.value === "ready") {
        return;
      }
      queueModelRequest(selectedModel.value);
    },
    { immediate: true },
  );

  watch(
    () => ({
      settings: { ...settings.value },
      semanticAxisProfile: selectedModel.value?.semantic_axis_profile ?? null,
    }),
    ({ settings: nextSettings }) => {
      forceLive2DRedraw();
      if (renderStatus.value !== "ready") {
        return;
      }
      const adapter = window.getLAppAdapter?.();
      if (!adapter?.applyRuntimeEffectsSettings) {
        const error = "live2d_runtime_effects_adapter_unavailable";
        console.error(`[AG99live] ${error}`);
        renderError.value = error;
        renderStatus.value = "error";
        clearMountedRendererState();
        modelLoadQueue = modelLoadQueue
          .then(() => releaseRenderer(error))
          .catch((releaseError) => {
            console.error("[AG99live] Failed to terminate Live2D renderer", releaseError);
          });
        return;
      }
      adapter.applyRuntimeEffectsSettings(
        selectLive2dRuntimeEffectsSettings(nextSettings, selectedModel.value),
      );
    },
    { deep: true },
  );

  onBeforeUnmount(async () => {
    disposed = true;
    modelRequestVersion += 1;
    cancelActiveModelLoad?.("live2d_renderer_unmounted");
    resizeObserver?.disconnect();
    resizeObserver = null;
    disposeForceRedrawListener?.();
    disposeForceRedrawListener = null;
    clearMountedRendererState();
    lastCanvasWidth = 0;
    lastCanvasHeight = 0;

    try {
      await modelLoadQueue;
      if (rendererLifecycleStarted) {
        await releaseRenderer("live2d_renderer_unmounted");
      }
    } catch (error) {
      console.warn("[AG99live] Failed to release Live2D delegate cleanly", error);
    }
  });

  return {
    containerRef,
    canvasRef,
    renderStatus,
    renderError,
    statusLabel,
  };
}
