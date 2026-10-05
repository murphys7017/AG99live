import { onBeforeUnmount, onMounted, watch, type Ref } from "vue";
import { buildCursorGazeInput } from "../model-engine/runtime/interactionSway";
import type { ModelSummary } from "../types/protocol";
import { useCursorGazeSettings } from "./cursorGazeSettings";

interface CursorTarget {
  x: number;
  y: number;
  horizontalRatio: number;
}

export function useCursorGaze(selectedModel: Ref<ModelSummary | null>): void {
  const settings = useCursorGazeSettings();
  let timer: number | null = null;
  let candidate: CursorTarget | null = null;
  let candidateSinceMs = 0;
  let active = false;
  let mounted = false;
  let pollInFlight = false;
  let pollRevision = 0;

  function canPoll(): boolean {
    return mounted
      && settings.enabled
      && !document.hidden
      && selectedModel.value !== null
      && !!window.ag99desktop?.getPetCursorTarget;
  }

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
    if (pollInFlight || !canPoll()) {
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
        || !canPoll()
        || selectedModel.value !== model
        || !target
        || !Number.isFinite(target.x)
        || !Number.isFinite(target.y)
        || !Number.isFinite(target.horizontalRatio)
      ) {
        return;
      }

      const now = performance.now();
      const moved = !candidate
        || Math.hypot(target.x - candidate.x, target.y - candidate.y) > settings.stationaryDistancePx;
      if (moved) {
        candidate = target;
        candidateSinceMs = now;
        // Do not keep staring at a departed cursor while the next dwell is undecided.
        window.getLAppAdapter?.().updateInteractionGaze?.(0);
        return;
      }
      candidate = target;
      if (now - candidateSinceMs < settings.dwellMs) {
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
      || pollInFlight
      || !canPoll()
    ) {
      return;
    }
    timer = window.setTimeout(() => {
      timer = null;
      void poll();
    }, settings.pollIntervalMs);
  }

  function start(): void {
    if (!canPoll()) {
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

  watch(selectedModel, () => {
    stop();
    start();
  }, { flush: "sync" });

  watch(settings, () => {
    stop();
    start();
  }, { flush: "sync" });

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
