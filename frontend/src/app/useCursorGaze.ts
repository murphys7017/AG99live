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
  let mounted = false;
  let pollInFlight = false;
  let pollRevision = 0;

  function stop(): void {
    pollRevision += 1;
    if (timer !== null) {
      window.clearTimeout(timer);
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
    if (pollInFlight || document.hidden) {
      return;
    }
    const model = selectedModel.value;
    const getCursorTarget = window.ag99desktop?.getPetCursorTarget;
    if (!model || !getCursorTarget) {
      return;
    }
    const revision = pollRevision;
    pollInFlight = true;
    try {
      const target = await getCursorTarget();
      if (
        revision !== pollRevision
        || document.hidden
        || selectedModel.value !== model
        || !target
        || !Number.isFinite(target.horizontalRatio)
      ) {
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
    } catch {
      return;
    } finally {
      pollInFlight = false;
      schedulePoll();
    }
  }

  function schedulePoll(): void {
    if (
      timer !== null
      || !mounted
      || document.hidden
      || !selectedModel.value
      || !window.ag99desktop?.getPetCursorTarget
    ) {
      return;
    }
    timer = window.setTimeout(() => {
      timer = null;
      void poll();
    }, POLL_INTERVAL_MS);
  }

  function start(): void {
    if (
      !mounted
      || document.hidden
      || !selectedModel.value
      || !window.ag99desktop?.getPetCursorTarget
    ) {
      return;
    }
    void poll();
  }

  function handleVisibilityChange(): void {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  }

  watch(selectedModel, (model) => {
    stop();
    if (model) start();
  });

  onMounted(() => {
    mounted = true;
    document.addEventListener("visibilitychange", handleVisibilityChange);
    start();
  });
  onBeforeUnmount(() => {
    mounted = false;
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    stop();
  });
}
