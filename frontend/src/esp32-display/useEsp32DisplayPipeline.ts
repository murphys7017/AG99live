import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import { sendEsp32DisplayFrame } from "./useEsp32DisplayConnection";
import {
  normalizeCrop,
  type Esp32DisplayConfig,
} from "./types";

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

function getWebGL2Context(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  try {
    return canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
  } catch {
    return null;
  }
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
  return { canvas, context, width: size, height: size };
}

function readCropRegion(
  gl: WebGL2RenderingContext,
  sourceWidth: number,
  sourceHeight: number,
  crop: Esp32DisplayConfig["crop"],
): { width: number; height: number; pixels: Uint8Array } | null {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return null;
  }
  const normalizedCrop = normalizeCrop(crop);
  const cropX = Math.max(0, Math.floor(normalizedCrop.x * sourceWidth));
  const cropTopY = Math.max(0, Math.floor(normalizedCrop.y * sourceHeight));
  let cropW = Math.max(1, Math.floor(normalizedCrop.w * sourceWidth));
  let cropH = Math.max(1, Math.floor(normalizedCrop.h * sourceHeight));
  cropW = Math.min(cropW, sourceWidth - cropX);
  cropH = Math.min(cropH, sourceHeight - cropTopY);
  if (cropW <= 0 || cropH <= 0) {
    return null;
  }
  const pixels = new Uint8Array(cropW * cropH * 4);
  const webglY = sourceHeight - cropTopY - cropH;
  const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const prevPack = gl.getParameter(gl.PACK_ALIGNMENT) as number;
  try {
    if (prevFbo !== null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(cropX, webglY, cropW, cropH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  } finally {
    gl.pixelStorei(gl.PACK_ALIGNMENT, prevPack || 4);
    if (prevFbo !== null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    }
  }
  flipRowsInPlace(pixels, cropW, cropH);
  unpremultiplyAlphaInPlace(pixels);
  return { width: cropW, height: cropH, pixels };
}

function flipRowsInPlace(pixels: Uint8Array, width: number, height: number): void {
  const rowSize = width * 4;
  const temp = new Uint8Array(rowSize);
  for (let y = 0; y < Math.floor(height / 2); y += 1) {
    const top = y * rowSize;
    const bottom = (height - y - 1) * rowSize;
    temp.set(pixels.subarray(top, top + rowSize));
    pixels.copyWithin(top, bottom, bottom + rowSize);
    pixels.set(temp, bottom);
  }
}

function unpremultiplyAlphaInPlace(pixels: Uint8Array): void {
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    if (a === 0 || a === 255) {
      continue;
    }
    const scale = 255 / a;
    pixels[i] = Math.min(255, Math.round(pixels[i] * scale));
    pixels[i + 1] = Math.min(255, Math.round(pixels[i + 1] * scale));
    pixels[i + 2] = Math.min(255, Math.round(pixels[i + 2] * scale));
  }
}

function isMostlyTransparent(pixels: Uint8Array): boolean {
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

function drawImageDataOnCanvas(
  context: CanvasRenderingContext2D,
  target: CompositeTarget,
  source: { pixels: Uint8Array; width: number; height: number },
  scaleMode: Esp32DisplayConfig["scaleMode"],
): void {
  const imageData = new ImageData(new Uint8ClampedArray(source.pixels), source.width, source.height);
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = source.width;
  tempCanvas.height = source.height;
  const tempContext = tempCanvas.getContext("2d");
  if (!tempContext) {
    return;
  }
  tempContext.putImageData(imageData, 0, 0);
  const scale = scaleMode === "stretch"
    ? null
    : scaleMode === "cover"
      ? Math.max(target.width / source.width, target.height / source.height)
      : Math.min(target.width / source.width, target.height / source.height);
  const destW = scale === null ? target.width : Math.max(1, Math.round(source.width * scale));
  const destH = scale === null ? target.height : Math.max(1, Math.round(source.height * scale));
  const destX = scale === null ? 0 : Math.round((target.width - destW) * 0.5);
  const destY = scale === null ? 0 : Math.round((target.height - destH) * 0.5);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    tempCanvas,
    0,
    0,
    source.width,
    source.height,
    destX,
    destY,
    destW,
    destH,
  );
}

function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(new Uint8Array(result));
      } else {
        reject(new Error("blob_read_failed"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("blob_read_failed"));
    reader.readAsArrayBuffer(blob);
  });
}

export function useEsp32DisplayPipeline(options: PipelineOptions): PipelineStatus {
  const fpsActual = ref(0);
  const lastFrameAt = ref(0);
  const framesSent = ref(0);
  const framesDropped = ref(0);
  const lastError = ref("");
  const active = ref(false);

  let rafHandle = 0;
  let running = false;
  let composite: CompositeTarget | null = null;
  let lastSentAt = 0;
  let frameCountInWindow = 0;
  let windowStart = 0;
  let canvasMissingLoggedAt = 0;
  let captureInFlight = false;

  function stop(): void {
    if (rafHandle !== 0) {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    }
    running = false;
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
      const gl = getWebGL2Context(canvas);
      if (!gl) {
        lastError.value = "webgl2_unavailable";
        return;
      }
      const region = readCropRegion(
        gl,
        gl.drawingBufferWidth || canvas.width,
        gl.drawingBufferHeight || canvas.height,
        config.crop,
      );
      if (!region) {
        lastError.value = "crop_invalid";
        return;
      }
      if (isMostlyTransparent(region.pixels)) {
        framesDropped.value += 1;
        return;
      }
      const ctx = composite.context;
      ctx.clearRect(0, 0, composite.width, composite.height);
      drawImageDataOnCanvas(ctx, composite, region, config.scaleMode);

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

  function loop(now: number): void {
    if (!running) {
      return;
    }
    rafHandle = requestAnimationFrame(loop);
    if (!options.connected.value) {
      lastSentAt = 0;
      windowStart = 0;
      frameCountInWindow = 0;
      return;
    }
    const targetInterval = 1000 / Math.max(1, options.config().fps);
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
    rafHandle = requestAnimationFrame(loop);
  }

  watch(
    () => options.connected.value,
    (next) => {
      if (next) {
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
