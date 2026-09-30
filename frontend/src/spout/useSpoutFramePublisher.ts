import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";

const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
const LIVE2D_FRAME_RENDERED_EVENT = "ag99live:live2d-frame-rendered";

function flipRows(
  pixels: Uint8Array,
  width: number,
  height: number,
  scratchRow: Uint8Array,
): void {
  const rowBytes = width * 4;
  for (let top = 0; top < Math.floor(height / 2); top += 1) {
    const bottom = height - top - 1;
    const topOffset = top * rowBytes;
    const bottomOffset = bottom * rowBytes;
    scratchRow.set(pixels.subarray(topOffset, topOffset + rowBytes));
    pixels.copyWithin(topOffset, bottomOffset, bottomOffset + rowBytes);
    pixels.set(scratchRow, bottomOffset);
  }
}

export function useSpoutFramePublisher(
  canvasRef: Ref<HTMLCanvasElement | null>,
  enabled: Ref<boolean>,
): void {
  let lastPublishedAt = 0;
  let lastError = "";
  let cachedCanvas: HTMLCanvasElement | null = null;
  let cachedGl: WebGL2RenderingContext | null = null;
  let pixelBuffer: Uint8Array | null = null;
  let rowBuffer: Uint8Array | null = null;
  let pixelWidth = 0;
  let pixelHeight = 0;
  let mounted = false;
  let listening = false;

  function setListening(next: boolean): void {
    if (!mounted || listening === next) {
      return;
    }
    listening = next;
    if (next) {
      window.addEventListener(LIVE2D_FRAME_RENDERED_EVENT, handleLive2DFrameRendered);
    } else {
      window.removeEventListener(LIVE2D_FRAME_RENDERED_EVENT, handleLive2DFrameRendered);
    }
  }

  function publishFrame(): void {
    const publish = window.ag99desktop?.publishSpoutFrame;
    const canvas = canvasRef.value;
    if (!enabled.value || !publish || !canvas) {
      return;
    }

    if (cachedCanvas !== canvas) {
      cachedCanvas = canvas;
      cachedGl = canvas.getContext("webgl2");
      pixelBuffer = null;
      rowBuffer = null;
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

    if (width !== pixelWidth || height !== pixelHeight || !pixelBuffer || !rowBuffer) {
      pixelWidth = width;
      pixelHeight = height;
      pixelBuffer = new Uint8Array(width * height * 4);
      rowBuffer = new Uint8Array(width * 4);
    }

    const pixels = pixelBuffer;
    const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const previousPackAlignment = gl.getParameter(gl.PACK_ALIGNMENT) as number;
    try {
      if (previousFramebuffer) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      // The Live2D WebGL drawing buffer is premultiplied-alpha. Preserve that
      // representation so OBS can blend it with the Spout2 premultiplied mode.
      flipRows(pixels, width, height, rowBuffer);
      publish(width, height, pixels);
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
