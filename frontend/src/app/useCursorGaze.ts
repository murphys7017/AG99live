import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { buildCursorGazeInput } from "../model-engine/runtime/interactionSway";
import type { ModelSummary } from "../types/protocol";

const POLL_INTERVAL_MS = 100;
const DWELL_THRESHOLD_MS = 450;
const STATIONARY_DISTANCE_PX = 14;

interface CursorTarget {
  x: number;
  y: number;
  horizontalRatio: number;
}

export function useCursorGaze(selectedModel: Ref<ModelSummary | null>): void {
  let timer: number | null = null;
  let candidate: CursorTarget | null = null;
  let candidateSinceMs = 0;
  let active = false;

  function stop(): void {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    candidate = null;
    candidateSinceMs = 0;
    if (active) {
      window.getLAppAdapter?.().stopInteractionGaze?.();
      active = false;
    }
  }

  async function poll(): Promise<void> {
    const model = selectedModel.value;
    if (!model || !window.ag99desktop?.getPetCursorTarget) {
      return;
    }
    const target = await window.ag99desktop.getPetCursorTarget();
    if (!target || !Number.isFinite(target.horizontalRatio)) {
      return;
    }
    const now = performance.now();
    const moved = !candidate
      || Math.hypot(target.x - candidate.x, target.y - candidate.y) > STATIONARY_DISTANCE_PX;
    if (moved) {
      candidate = target;
      candidateSinceMs = now;
      // Do not keep staring at a departed cursor while the next dwell is undecided.
      window.getLAppAdapter?.().updateInteractionGaze?.(0);
      return;
    }
    candidate = target;
    if (now - candidateSinceMs < DWELL_THRESHOLD_MS) {
      return;
    }
    if (!active) {
      const input = buildCursorGazeInput(model, target.horizontalRatio);
      if (!input) {
        return;
      }
      active = window.getLAppAdapter?.().startInteractionGaze?.(input) === true;
      if (active) {
        console.info("[CursorGaze] dwell gaze started.", {
          axisId: input.axisId,
          targetRatio: input.targetRatio,
          bindingCount: input.bindings.length,
        });
      }
      return;
    }
    window.getLAppAdapter?.().updateInteractionGaze?.(target.horizontalRatio);
  }

  function start(): void {
    if (timer !== null || !window.ag99desktop?.getPetCursorTarget) {
      return;
    }
    timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    void poll();
  }

  watch(selectedModel, () => {
    if (active) {
      window.getLAppAdapter?.().stopInteractionGaze?.();
      active = false;
    }
  });
  onMounted(start);
  onBeforeUnmount(stop);
}
