import { captureRealtimeDesktopScreenshot } from "./desktopCapture.js";

export async function captureObservationFrame(): Promise<
  { ok: true; data: string; mime_type: "image/jpeg" } | { ok: false; error: string }
> {
  const image = await captureRealtimeDesktopScreenshot("observation");
  if (!image) return { ok: false, error: "desktop_capture_unavailable" };
  const bitmap = await createImageBitmap(await (await fetch(image.data)).blob());
  try {
    const scale = Math.min(1, 768 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("desktop_capture_canvas_unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.65).split(",", 2)[1];
    if (!data || data.length > 1_000_000) throw new Error("desktop_capture_too_large");
    return { ok: true, data, mime_type: "image/jpeg" };
  } finally {
    bitmap.close();
  }
}
