export interface DesktopCaptureImagePayload {
  data: string;
  mime_type: "image/jpeg";
  source: "screen";
  captured_at: string;
}

let pendingCapture: Promise<DesktopCaptureImagePayload | null> | null = null;
let captureSequence = 0;
let captureNeedsRecovery = false;

export async function captureRealtimeDesktopScreenshot(
  purpose: "foreground" | "observation" = "foreground",
): Promise<DesktopCaptureImagePayload | null> {
  const capture = window.ag99desktop?.captureDesktopScreenshot;
  if (!capture) {
    console.warn("[DesktopCapture] Desktop capture bridge is unavailable");
    return null;
  }
  // Automatic sampling must not accumulate native requests after a hang.
  // A user-triggered screenshot can still make a fresh recovery attempt.
  if (purpose === "observation" && captureNeedsRecovery) return null;
  if (pendingCapture === null) {
    // Share the bounded operation, not the native IPC promise: a timed-out
    // capture must release the slot so foreground screenshots can recover.
    const operation = (async (): Promise<DesktopCaptureImagePayload | null> => {
      const sequence = ++captureSequence;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const native = capture();
        void native.then(() => {
          // Late completion permits a new capture; never reuse its old image.
          if (sequence === captureSequence) captureNeedsRecovery = false;
        }, () => undefined);
        const result = await Promise.race([
          native,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              captureNeedsRecovery = true;
              reject(new Error("desktop_capture_timeout"));
            }, 10_000);
          }),
        ]);
        if (!result) console.warn("[DesktopCapture] Desktop capture returned no image");
        return result ?? null;
      } catch (error) {
        console.warn("[DesktopCapture] Failed to capture realtime desktop screenshot", error);
        return null;
      } finally {
        clearTimeout(timeout);
      }
    })();
    pendingCapture = operation;
    void operation.finally(() => {
      // A late native response cannot replace a newer operation's result.
      if (pendingCapture === operation) pendingCapture = null;
    });
  }
  return pendingCapture;
}
