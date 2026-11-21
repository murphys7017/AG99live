/** Position of the output device on the AudioContext timeline, in seconds. */
export function presentedOutputTime(context: AudioContext, now = performance.now()): number {
  const rendered = context.currentTime;
  const stamp = context.getOutputTimestamp?.();
  if (stamp?.contextTime !== undefined && stamp.performanceTime) {
    const elapsed = context.state === "running" ? (now - stamp.performanceTime) / 1000 : 0;
    return Math.max(0, Math.min(rendered, stamp.contextTime + elapsed));
  }
  return Math.max(0, rendered - (context.baseLatency || 0) - (context.outputLatency || 0));
}

/** Run once the device clock reaches a scheduled sample. Cancellation is idempotent. */
export function onOutputPresented(
  context: AudioContext, targetTime: number, notify: (atMs: number) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  function check(): void {
    const now = performance.now();
    const remainingMs = (targetTime - presentedOutputTime(context, now)) * 1000;
    if (context.state === "running" && remainingMs <= 0) {
      notify(now + remainingMs);
    } else {
      timer = setTimeout(check, context.state === "running" ? Math.max(4, Math.min(100, remainingMs)) : 100);
    }
  }
  check();
  return () => clearTimeout(timer);
}
