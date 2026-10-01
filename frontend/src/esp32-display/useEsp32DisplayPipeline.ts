import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import { setBackgroundFrameConsumerActive } from "../live2d-renderer/backgroundFrameConsumers";
import { sendEsp32DisplayFrame } from "./useEsp32DisplayConnection";
import {
  normalizeCrop,
  type Esp32DisplayConfig,
} from "./types";

const LIVE2D_FRAME_RENDERED_EVENT = "ag99live:live2d-frame-rendered";

interface PipelineOptions {
  config: () => Esp32DisplayConfig;
  connected: Ref<boolean>;
}

interface PipelineStatus {
  fpsActual: Ref<number>;
  lastFrameAt: Ref<number>;
  framesSent: Ref<number>;
  framesDropped: Ref<number>;
  lastError: Ref<string>;
  active: Ref<boolean>;
}

const LIVE2D_CANVAS_ID = "canvas";

function findLive2DCanvas(): HTMLCanvasElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.getElementById(LIVE2D_CANVAS_ID);
  if (canvas instanceof HTMLCanvasElement) {
    return canvas;
  }
  return null;
}

interface CompositeTarget {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
}

function createCompositeCanvas(size: number): CompositeTarget | null {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return {
    canvas,
    context,
    width: size,
    height: size,
  };
}

function getCropRegion(
  sourceWidth: number,
  sourceHeight: number,
  crop: Esp32DisplayConfig["crop"],
): { x: number; y: number; width: number; height: number } | null {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return null;
  }
  const normalizedCrop = normalizeCrop(crop);
  const x = Math.max(0, Math.floor(normalizedCrop.x * sourceWidth));
  const y = Math.max(0, Math.floor(normalizedCrop.y * sourceHeight));
  const width = Math.min(
    Math.max(1, Math.floor(normalizedCrop.w * sourceWidth)),
    sourceWidth - x,
  );
  const height = Math.min(
    Math.max(1, Math.floor(normalizedCrop.h * sourceHeight)),
    sourceHeight - y,
  );
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function isMostlyTransparent(pixels: Uint8ClampedArray): boolean {
  const step = Math.max(1, Math.floor(pixels.length / 4 / 64));
  let nonZero = 0;
  let sampled = 0;
  for (let i = 3; i < pixels.length; i += 4 * step) {
    sampled += 1;
    if (pixels[i] > 8) {
      nonZero += 1;
    }
  }
  if (sampled === 0) {
    return true;
  }
  return nonZero / sampled < 0.01;
}

function drawCanvasRegionOnCanvas(
  target: CompositeTarget,
  sourceCanvas: HTMLCanvasElement,
  source: { x: number; y: number; width: number; height: number },
  scaleMode: Esp32DisplayConfig["scaleMode"],
): void {
  const scale = scaleMode === "stretch"
    ? null
    : scaleMode === "cover"
      ? Math.max(target.width / source.width, target.height / source.height)
      : Math.min(target.width / source.width, target.height / source.height);
  const destW = scale === null ? target.width : Math.max(1, Math.round(source.width * scale));
  const destH = scale === null ? target.height : Math.max(1, Math.round(source.height * scale));
  const destX = scale === null ? 0 : Math.round((target.width - destW) * 0.5);
  const destY = scale === null ? 0 : Math.round((target.height - destH) * 0.5);
  target.context.drawImage(
    sourceCanvas,
    source.x,
    source.y,
    source.width,
    source.height,
    destX,
    destY,
    destW,
    destH,
  );
}

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export function useEsp32DisplayPipeline(options: PipelineOptions): PipelineStatus {
  const fpsActual = ref(0);
  const lastFrameAt = ref(0);
  const framesSent = ref(0);
  const framesDropped = ref(0);
  const lastError = ref("");
  const active = ref(false);

  let running = false;
  let composite: CompositeTarget | null = null;
  let lastSentAt = 0;
  let frameCountInWindow = 0;
  let windowStart = 0;
  let canvasMissingLoggedAt = 0;
  let captureInFlight = false;
  let listening = false;

  function setListening(next: boolean): void {
    if (listening === next) {
      return;
    }
    listening = next;
    if (next) {
      window.addEventListener(LIVE2D_FRAME_RENDERED_EVENT, handleLive2DFrameRendered);
    } else {
      window.removeEventListener(LIVE2D_FRAME_RENDERED_EVENT, handleLive2DFrameRendered);
    }
  }

  function stop(): void {
    running = false;
    setListening(false);
    setBackgroundFrameConsumerActive("esp32", false);
    active.value = false;
  }

  async function captureAndSend(now: number): Promise<void> {
    if (captureInFlight) {
      framesDropped.value += 1;
      return;
    }
    captureInFlight = true;
    try {
      const config = options.config();
      if (!composite || composite.width !== config.outputSize) {
        composite = createCompositeCanvas(config.outputSize);
        if (!composite) {
          lastError.value = "composite_canvas_unavailable";
          return;
        }
      }
      const canvas = findLive2DCanvas();
      if (!canvas) {
        lastError.value = "live2d_canvas_missing";
        if (now - canvasMissingLoggedAt > 1000) {
          canvasMissingLoggedAt = now;
          console.warn("[Esp32Display] Live2D canvas not found yet; waiting for model to load.");
        }
        return;
      }
      canvasMissingLoggedAt = 0;
      const region = getCropRegion(canvas.width, canvas.height, config.crop);
      if (!region) {
        lastError.value = "crop_invalid";
        return;
      }
      const ctx = composite.context;
      ctx.clearRect(0, 0, composite.width, composite.height);
      try {
        drawCanvasRegionOnCanvas(composite, canvas, region, config.scaleMode);
      } catch (error) {
        lastError.value = error instanceof Error ? error.message : "canvas_draw_failed";
        return;
      }
      if (isMostlyTransparent(ctx.getImageData(0, 0, composite.width, composite.height).data)) {
        framesDropped.value += 1;
        return;
      }

      let blob: Blob | null = null;
      try {
        blob = await new Promise<Blob | null>((resolve) => {
          composite!.canvas.toBlob((b) => resolve(b), "image/jpeg", config.jpegQuality);
        });
      } catch (error) {
        lastError.value = error instanceof Error ? error.message : "toBlob_failed";
        return;
      }
      if (!blob) {
        lastError.value = "toBlob_null";
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = await blobToUint8Array(blob);
      } catch (error) {
        lastError.value = error instanceof Error ? error.message : "blob_read_failed";
        return;
      }
      const ok = await sendEsp32DisplayFrame(bytes);
      if (ok) {
        framesSent.value += 1;
        lastFrameAt.value = now;
        lastError.value = "";
      } else {
        framesDropped.value += 1;
        lastError.value = "send_rejected";
      }
    } finally {
      captureInFlight = false;
    }
  }

  function handleLive2DFrameRendered(): void {
    if (!running) {
      return;
    }
    const now = performance.now();
    const config = options.config();
    if (!options.connected.value || !config.enabled) {
      lastSentAt = 0;
      windowStart = 0;
      frameCountInWindow = 0;
      return;
    }
    const targetInterval = 1000 / Math.max(1, config.fps);
    if (lastSentAt !== 0 && now - lastSentAt < targetInterval) {
      return;
    }
    if (windowStart === 0) {
      windowStart = now;
    }
    lastSentAt = now;
    frameCountInWindow += 1;
    if (now - windowStart >= 1000) {
      fpsActual.value = Math.round((frameCountInWindow * 1000) / (now - windowStart));
      windowStart = now;
      frameCountInWindow = 0;
    }
    void captureAndSend(now);
  }

  function start(): void {
    if (running) {
      return;
    }
    running = true;
    active.value = true;
    setBackgroundFrameConsumerActive("esp32", true);
    setListening(true);
  }

  watch(
    () => [options.connected.value, options.config().enabled] as const,
    ([connected, enabled]) => {
      if (connected && enabled) {
        start();
      } else {
        stop();
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    stop();
  });

  return {
    fpsActual,
    lastFrameAt,
    framesSent,
    framesDropped,
    lastError,
    active,
  };
}
