export interface DesktopCaptureImagePayload {
  data: string;
  mime_type: "image/jpeg";
  source: "screen";
  captured_at: string;
}

let pendingNativeCapture: Promise<DesktopCaptureImagePayload | null> | null = null;

export async function captureRealtimeDesktopScreenshot(): Promise<DesktopCaptureImagePayload | null> {
  const capture = window.ag99desktop?.captureDesktopScreenshot;
  if (!capture) {
    console.warn("[DesktopCapture] Desktop capture bridge is unavailable");
    return null;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // The input must settle even if Electron's capture request never returns.
    // This is shorter than Adapter's 15 s sealed-input assembly deadline.
    if (pendingNativeCapture === null) {
      const pending = capture();
      pendingNativeCapture = pending;
      void pending.finally(() => {
        if (pendingNativeCapture === pending) pendingNativeCapture = null;
      }).catch(() => undefined);
    }
    const result = await Promise.race([
      pendingNativeCapture,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("desktop_capture_timeout")), 10_000);
      }),
    ]);
    if (!result) {
      console.warn("[DesktopCapture] Desktop capture returned no image");
    }
    return result ?? null;
  } catch (error) {
    console.warn("[DesktopCapture] Failed to capture realtime desktop screenshot", error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
