import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";

const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
const STATS_INTERVAL_MS = 10_000;
const LIVE2D_FRAME_RENDERED_EVENT = "ag99live:live2d-frame-rendered";

export function useSpoutFramePublisher(
  canvasRef: Ref<HTMLCanvasElement | null>,
  enabled: Ref<boolean>,
): void {
  let lastPublishedAt = 0;
  let lastError = "";
  let cachedCanvas: HTMLCanvasElement | null = null;
  let cachedGl: WebGL2RenderingContext | null = null;
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
  let readbackMs = 0;
  let maxReadbackMs = 0;
  let ipcCallMs = 0;
  let maxIpcCallMs = 0;

  function applySenderStatus(status: { canPublish: boolean; revision: number }): void {
    if (status.revision < senderStatusRevision) {
      return;
    }
    senderStatusRevision = status.revision;
    senderCanPublish = status.canPublish;
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
        });
      }
      window.addEventListener(LIVE2D_FRAME_RENDERED_EVENT, handleLive2DFrameRendered);
    } else {
      window.removeEventListener(LIVE2D_FRAME_RENDERED_EVENT, handleLive2DFrameRendered);
      detachSenderStatus?.();
      detachSenderStatus = null;
      senderCanPublish = false;
      senderStatusRevision = -1;
    }
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
      cachedCanvas = canvas;
      cachedGl = canvas.getContext("webgl2");
      pixelBuffer = null;
      pixelWidth = 0;
      pixelHeight = 0;
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

    if (width !== pixelWidth || height !== pixelHeight || !pixelBuffer) {
      pixelWidth = width;
      pixelHeight = height;
      pixelBuffer = new Uint8Array(width * height * 4);
    }

    const pixels = pixelBuffer;
    const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const previousPackAlignment = gl.getParameter(gl.PACK_ALIGNMENT) as number;
    try {
      if (previousFramebuffer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      const readStartedAt = performance.now();
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const readDuration = performance.now() - readStartedAt;
      // Keep the browser's premultiplied-alpha bytes; the native Sender applies
      // the vertical inversion while copying into the Spout texture.
      const ipcStartedAt = performance.now();
      publish(width, height, pixels);
      const ipcDuration = performance.now() - ipcStartedAt;
      recordStats(width * height * 4, readDuration, ipcDuration);
      lastError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : "spout_frame_read_failed";
      if (message !== lastError) {
        lastError = message;
        console.warn("[Spout] Failed to read the Live2D WebGL frame.", error);
      }
    } finally {
      gl.pixelStorei(gl.PACK_ALIGNMENT, previousPackAlignment || 4);
      if (previousFramebuffer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
      }
    }
  }

  function recordStats(bytes: number, readDurationMs: number, ipcDurationMs: number): void {
    statsFrames += 1;
    statsBytes += bytes;
    readbackMs += readDurationMs;
    maxReadbackMs = Math.max(maxReadbackMs, readDurationMs);
    ipcCallMs += ipcDurationMs;
    maxIpcCallMs = Math.max(maxIpcCallMs, ipcDurationMs);

    const now = performance.now();
    const elapsedMs = now - statsWindowStartedAt;
    if (elapsedMs < STATS_INTERVAL_MS) {
      return;
    }
    console.info(
      "[Spout] Renderer readbacks=%d readback_fps=%s readback_bytes=%d readback_avg_ms=%s readback_max_ms=%s ipc_call_avg_ms=%s ipc_call_max_ms=%s",
      statsFrames,
      (statsFrames * 1000 / elapsedMs).toFixed(1),
      statsBytes,
      (readbackMs / statsFrames).toFixed(2),
      maxReadbackMs.toFixed(2),
      (ipcCallMs / statsFrames).toFixed(2),
      maxIpcCallMs.toFixed(2),
    );
    statsWindowStartedAt = now;
    statsFrames = 0;
    statsBytes = 0;
    readbackMs = 0;
    maxReadbackMs = 0;
    ipcCallMs = 0;
    maxIpcCallMs = 0;
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
    mounted = false;
  });
}
