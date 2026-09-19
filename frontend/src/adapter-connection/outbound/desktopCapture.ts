export interface DesktopCaptureImagePayload {
  data: string;
  mime_type: "image/jpeg";
  source: "screen";
  captured_at: string;
}

export async function captureRealtimeDesktopScreenshot(): Promise<DesktopCaptureImagePayload | null> {
  const capture = window.ag99desktop?.captureDesktopScreenshot;
  if (!capture) {
    console.warn("[DesktopCapture] Desktop capture bridge is unavailable");
    return null;
  }
  try {
    const result = await capture();
    if (!result) {
      console.warn("[DesktopCapture] Desktop capture returned no image");
    }
    return result ?? null;
  } catch (error) {
    console.warn("[DesktopCapture] Failed to capture realtime desktop screenshot", error);
    return null;
  }
}
