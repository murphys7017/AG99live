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

type RenderStatus = "idle" | "loading" | "ready" | "error";

const LIVE2D_CORE_SCRIPT_ID = "ag99live-live2d-core";
const LIVE2D_RENDER_DPR_CAP = 1.25;

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

export function useLive2dRenderer(selectedModel: Ref<ModelSummary | null>) {
  const containerRef = ref<HTMLDivElement | null>(null);
  const canvasRef = ref<HTMLCanvasElement | null>(null);
  const renderStatus = ref<RenderStatus>("idle");
  const renderError = ref("");
  const mountedModelUrl = shallowRef("");
  const resizeLive2D = shallowRef<null | (() => void)>(null);
  let resizeObserver: ResizeObserver | null = null;
  let disposeForceRedrawListener: (() => void) | null = null;

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

  function syncCanvasSize() {
    const container = containerRef.value;
    const canvas = canvasRef.value;
    if (!container || !canvas) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const width = Math.max(rect.width, 1);
    const height = Math.max(rect.height, 1);
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, LIVE2D_RENDER_DPR_CAP));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  function forceLive2DRedraw() {
    syncCanvasSize();
    resizeLive2D.value?.();

    window.requestAnimationFrame(() => {
      syncCanvasSize();
      resizeLive2D.value?.();
    });
  }

  async function loadModel(model: ModelSummary) {
    renderStatus.value = "loading";
    renderError.value = "";

    try {
      await nextTick();
      syncCanvasSize();
      await ensureLive2DCoreLoaded();

      const [{ initializeLive2D }, { updateModelConfig }, { LAppDelegate }] =
        await Promise.all([
          import("@cubismsdksamples/main"),
          import("@cubismsdksamples/lappdefine"),
          import("@cubismsdksamples/lappdelegate"),
        ]);

      const { baseUrl, modelDir, modelFileName } = parseModelUrl(model.model_url);
      updateModelConfig(baseUrl, modelDir, modelFileName);
      initializeLive2D();
      await nextTick();
      syncCanvasSize();
      resizeLive2D.value = () => LAppDelegate.getInstance().onResize();
      resizeLive2D.value();

      mountedModelUrl.value = model.model_url;
      renderStatus.value = "ready";
    } catch (error) {
      console.error("[AG99live] Failed to initialize Live2D renderer", error);
      renderError.value =
        error instanceof Error ? error.message : "Unknown Live2D initialization error.";
      renderStatus.value = "error";
    }
  }

  onMounted(() => {
    resizeObserver = new ResizeObserver(() => {
      syncCanvasSize();
      resizeLive2D.value?.();
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
    async (nextUrl) => {
      if (!nextUrl) {
        mountedModelUrl.value = "";
        resizeLive2D.value = null;
        renderError.value = "";
        renderStatus.value = "idle";
        return;
      }

      if (nextUrl === mountedModelUrl.value && renderStatus.value === "ready") {
        return;
      }

      if (!selectedModel.value) {
        return;
      }

      await loadModel(selectedModel.value);
    },
    { immediate: true },
  );

  onBeforeUnmount(async () => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    disposeForceRedrawListener?.();
    disposeForceRedrawListener = null;
    mountedModelUrl.value = "";
    resizeLive2D.value = null;

    try {
      const { LAppDelegate } = await import("@cubismsdksamples/lappdelegate");
      LAppDelegate.releaseInstance();
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
