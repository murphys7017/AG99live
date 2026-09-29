import { onBeforeUnmount, onMounted, type Ref } from "vue";

const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
const LIVE2D_FRAME_RENDERED_EVENT = "ag99live:live2d-frame-rendered";

function flipRows(
  pixels: Uint8Array,
  width: number,
  height: number,
): void {
  const rowBytes = width * 4;
  const row = new Uint8Array(rowBytes);
  for (let top = 0; top < Math.floor(height / 2); top += 1) {
    const bottom = height - top - 1;
    const topOffset = top * rowBytes;
    const bottomOffset = bottom * rowBytes;
    row.set(pixels.subarray(topOffset, topOffset + rowBytes));
    pixels.copyWithin(topOffset, bottomOffset, bottomOffset + rowBytes);
    pixels.set(row, bottomOffset);
  }
}

export function useSpoutFramePublisher(canvasRef: Ref<HTMLCanvasElement | null>): void {
  let lastPublishedAt = 0;
  let lastError = "";

  function publishFrame(): void {
    const publish = window.ag99desktop?.publishSpoutFrame;
    const canvas = canvasRef.value;
    if (!publish || !canvas) {
      return;
    }

    const gl = canvas.getContext("webgl2");
    if (!gl) {
      return;
    }

    const width = gl.drawingBufferWidth || canvas.width;
    const height = gl.drawingBufferHeight || canvas.height;
    if (width <= 0 || height <= 0) {
      return;
    }

    const pixels = new Uint8Array(width * height * 4);
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
      flipRows(pixels, width, height);
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
    window.addEventListener(LIVE2D_FRAME_RENDERED_EVENT, handleLive2DFrameRendered);
  });

  onBeforeUnmount(() => {
    window.removeEventListener(LIVE2D_FRAME_RENDERED_EVENT, handleLive2DFrameRendered);
  });
}
