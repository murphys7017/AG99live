import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { setBackgroundFrameConsumerActive } from "../live2d-renderer/backgroundFrameConsumers";

const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
const STATS_INTERVAL_MS = 10_000;
const LIVE2D_FRAME_RENDERED_EVENT = "ag99live:live2d-frame-rendered";

interface PendingReadback {
  width: number;
  height: number;
  readPixelsMs: number;
}

export function useSpoutFramePublisher(
  canvasRef: Ref<HTMLCanvasElement | null>,
  enabled: Ref<boolean>,
): void {
  let lastPublishedAt = 0;
  let lastError = "";
  let cachedCanvas: HTMLCanvasElement | null = null;
  let cachedGl: WebGL2RenderingContext | null = null;
  let readbackBuffer: WebGLBuffer | null = null;
  let readbackBufferSize = 0;
  let pendingReadbackSync: WebGLSync | null = null;
  let pendingReadback: PendingReadback | null = null;
  let pixelBuffer: Uint8Array | null = null;
  let pixelWidth = 0;
  let pixelHeight = 0;
  let mounted = false;
  let listening = false;
  let senderCanPublish = false;
  let senderStatusRevision = -1;
  let detachSenderStatus: (() => void) | null = null;
  let statsWindowStartedAt = performance.now();
  let statsFrames = 0;
  let statsBytes = 0;
  let readPixelsMs = 0;
  let maxReadPixelsMs = 0;
  let readbackCopyMs = 0;
  let maxReadbackCopyMs = 0;
  let ipcCallMs = 0;
  let maxIpcCallMs = 0;
  let skippedPendingReadbacks = 0;

  function applySenderStatus(status: { canPublish: boolean; revision: number }): void {
    if (status.revision < senderStatusRevision) {
      return;
    }
    senderStatusRevision = status.revision;
    senderCanPublish = status.canPublish;
    if (!senderCanPublish) {
      discardPendingReadback();
    }
    updateFrameConsumerActivity();
  }

  function updateFrameConsumerActivity(): void {
    setBackgroundFrameConsumerActive(
      "spout",
      listening && enabled.value && senderCanPublish,
    );
  }

  function setListening(next: boolean): void {
    if (!mounted || listening === next) {
      return;
    }
    listening = next;
    if (next) {
      senderCanPublish = false;
      detachSenderStatus =
        window.ag99desktop?.onSpoutSenderStatus(applySenderStatus) ?? null;
      const getStatus = window.ag99desktop?.getSpoutSenderStatus;
      if (getStatus) {
        void getStatus().then(applySenderStatus).catch(() => {
          senderCanPublish = false;
          updateFrameConsumerActivity();
        });
      }
      window.addEventListener(LIVE2D_FRAME_RENDERED_EVENT, handleLive2DFrameRendered);
    } else {
      window.removeEventListener(LIVE2D_FRAME_RENDERED_EVENT, handleLive2DFrameRendered);
      detachSenderStatus?.();
      detachSenderStatus = null;
      senderCanPublish = false;
      senderStatusRevision = -1;
      releaseReadbackResources();
    }
    updateFrameConsumerActivity();
  }

  function discardPendingReadback(): void {
    if (cachedGl && pendingReadbackSync) {
      cachedGl.deleteSync(pendingReadbackSync);
    }
    pendingReadbackSync = null;
    pendingReadback = null;
  }

  function releaseReadbackResources(): void {
    const gl = cachedGl;
    discardPendingReadback();
    if (gl && readbackBuffer) {
      gl.deleteBuffer(readbackBuffer);
    }
    cachedCanvas = null;
    cachedGl = null;
    readbackBuffer = null;
    readbackBufferSize = 0;
    pixelBuffer = null;
    pixelWidth = 0;
    pixelHeight = 0;
  }

  function ensureReadbackBuffer(
    gl: WebGL2RenderingContext,
    byteLength: number,
  ): WebGLBuffer {
    if (!readbackBuffer) {
      readbackBuffer = gl.createBuffer();
      if (!readbackBuffer) {
        throw new Error("spout_pixel_pack_buffer_unavailable");
      }
    }
    if (readbackBufferSize !== byteLength) {
      discardPendingReadback();
      const previousPixelPackBuffer = gl.getParameter(
        gl.PIXEL_PACK_BUFFER_BINDING,
      ) as WebGLBuffer | null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, readbackBuffer);
      try {
        gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLength, gl.STREAM_READ);
      } finally {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previousPixelPackBuffer);
      }
      readbackBufferSize = byteLength;
    }
    return readbackBuffer;
  }

  function publishFrame(): void {
    if (!enabled.value || !senderCanPublish) {
      return;
    }
    const publish = window.ag99desktop?.publishSpoutFrame;
    const canvas = canvasRef.value;
    if (!publish || !canvas) {
      return;
    }

    if (cachedCanvas !== canvas) {
      releaseReadbackResources();
      cachedCanvas = canvas;
      cachedGl = canvas.getContext("webgl2");
    }

    const gl = cachedGl;
    if (!gl) {
      return;
    }

    const width = gl.drawingBufferWidth || canvas.width;
    const height = gl.drawingBufferHeight || canvas.height;
    if (width <= 0 || height <= 0) {
      return;
    }

    const byteLength = width * height * 4;
    if (width !== pixelWidth || height !== pixelHeight || !pixelBuffer) {
      pixelWidth = width;
      pixelHeight = height;
      pixelBuffer = new Uint8Array(byteLength);
    }

    const pixels = pixelBuffer;
    if (
      pendingReadback
      && (pendingReadback.width !== width || pendingReadback.height !== height)
    ) {
      discardPendingReadback();
    }

    try {
      const buffer = ensureReadbackBuffer(gl, byteLength);
      if (pendingReadbackSync && pendingReadback) {
        const waitResult = gl.clientWaitSync(pendingReadbackSync, 0, 0);
        if (waitResult === gl.TIMEOUT_EXPIRED) {
          skippedPendingReadbacks += 1;
          return;
        }
        if (
          waitResult !== gl.ALREADY_SIGNALED
          && waitResult !== gl.CONDITION_SATISFIED
        ) {
          discardPendingReadback();
          throw new Error("spout_readback_fence_failed");
        }

        const completedReadback = pendingReadback;
        gl.deleteSync(pendingReadbackSync);
        pendingReadbackSync = null;
        pendingReadback = null;
        const previousPixelPackBuffer = gl.getParameter(
          gl.PIXEL_PACK_BUFFER_BINDING,
        ) as WebGLBuffer | null;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
        const copyStartedAt = performance.now();
        try {
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
        } finally {
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previousPixelPackBuffer);
        }
        const copyDuration = performance.now() - copyStartedAt;
        const publish = window.ag99desktop?.publishSpoutFrame;
        if (publish) {
          const ipcStartedAt = performance.now();
          // Keep premultiplied-alpha bytes; the native Sender flips rows for Spout.
          publish(completedReadback.width, completedReadback.height, pixels);
          const ipcDuration = performance.now() - ipcStartedAt;
          recordStats(byteLength, completedReadback.readPixelsMs, copyDuration, ipcDuration);
          lastError = "";
        }
      }

      const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
      const previousPixelPackBuffer = gl.getParameter(
        gl.PIXEL_PACK_BUFFER_BINDING,
      ) as WebGLBuffer | null;
      if (previousFramebuffer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      const readStartedAt = performance.now();
      try {
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        const readDuration = performance.now() - readStartedAt;
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!sync) {
          throw new Error("spout_readback_fence_unavailable");
        }
        pendingReadbackSync = sync;
        pendingReadback = { width, height, readPixelsMs: readDuration };
        gl.flush();
      } finally {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previousPixelPackBuffer);
        if (previousFramebuffer) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "spout_frame_read_failed";
      if (message !== lastError) {
        lastError = message;
        console.warn("[Spout] Failed to read the Live2D WebGL frame.", error);
      }
    }
  }

  function recordStats(
    bytes: number,
    readPixelsDurationMs: number,
    readbackCopyDurationMs: number,
    ipcDurationMs: number,
  ): void {
    statsFrames += 1;
    statsBytes += bytes;
    readPixelsMs += readPixelsDurationMs;
    maxReadPixelsMs = Math.max(maxReadPixelsMs, readPixelsDurationMs);
    readbackCopyMs += readbackCopyDurationMs;
    maxReadbackCopyMs = Math.max(maxReadbackCopyMs, readbackCopyDurationMs);
    ipcCallMs += ipcDurationMs;
    maxIpcCallMs = Math.max(maxIpcCallMs, ipcDurationMs);

    const now = performance.now();
    const elapsedMs = now - statsWindowStartedAt;
    if (elapsedMs < STATS_INTERVAL_MS) {
      return;
    }
    console.info(
      "[Spout] Renderer readbacks=%d readback_fps=%s readback_bytes=%d readPixels_submit_avg_ms=%s readPixels_submit_max_ms=%s readback_copy_avg_ms=%s readback_copy_max_ms=%s ipc_call_avg_ms=%s ipc_call_max_ms=%s skipped_gpu_busy=%d",
      statsFrames,
      (statsFrames * 1000 / elapsedMs).toFixed(1),
      statsBytes,
      (readPixelsMs / statsFrames).toFixed(2),
      maxReadPixelsMs.toFixed(2),
      (readbackCopyMs / statsFrames).toFixed(2),
      maxReadbackCopyMs.toFixed(2),
      (ipcCallMs / statsFrames).toFixed(2),
      maxIpcCallMs.toFixed(2),
      skippedPendingReadbacks,
    );
    statsWindowStartedAt = now;
    statsFrames = 0;
    statsBytes = 0;
    readPixelsMs = 0;
    maxReadPixelsMs = 0;
    readbackCopyMs = 0;
    maxReadbackCopyMs = 0;
    ipcCallMs = 0;
    maxIpcCallMs = 0;
    skippedPendingReadbacks = 0;
  }

  function handleLive2DFrameRendered(): void {
    const now = performance.now();
    if (lastPublishedAt !== 0 && now - lastPublishedAt < FRAME_INTERVAL_MS) {
      return;
    }
    lastPublishedAt = now;
    publishFrame();
  }

  onMounted(() => {
    mounted = true;
    setListening(enabled.value);
  });

  const stopEnabledWatch = watch(enabled, setListening);

  onBeforeUnmount(() => {
    stopEnabledWatch();
    setListening(false);
    releaseReadbackResources();
    mounted = false;
  });
}
