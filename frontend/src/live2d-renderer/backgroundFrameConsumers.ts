const BACKGROUND_IDLE_FRAME_RATE = 10;
const BACKGROUND_OUTPUT_FRAME_RATE = 30;
const BACKGROUND_FRAME_RATE_CHANGED_EVENT = "ag99live:background-frame-rate-changed";
const activeConsumers = new Set<string>();
let currentFrameRate: number | null = null;

export function setBackgroundFrameConsumerActive(id: string, active: boolean): void {
  if (active) {
    activeConsumers.add(id);
  } else {
    activeConsumers.delete(id);
  }
  const nextFrameRate = activeConsumers.size > 0
    ? BACKGROUND_OUTPUT_FRAME_RATE
    : BACKGROUND_IDLE_FRAME_RATE;
  if (currentFrameRate === nextFrameRate) {
    return;
  }
  currentFrameRate = nextFrameRate;
  document.documentElement.dataset.live2dBackgroundFrameRate = String(nextFrameRate);
  window.dispatchEvent(new CustomEvent(BACKGROUND_FRAME_RATE_CHANGED_EVENT, {
    detail: nextFrameRate,
  }));
}
