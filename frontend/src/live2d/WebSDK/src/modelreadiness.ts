export type Live2DModelLoadStatus = "idle" | "loading" | "ready" | "error";

interface Live2DModelLoadState {
  generation: number;
  status: Live2DModelLoadStatus;
  error: string;
}

let state: Live2DModelLoadState = { generation: 0, status: "idle", error: "" };
let resolveCurrent: (() => void) | null = null;
let rejectCurrent: ((error: Error) => void) | null = null;
let currentPromise: Promise<void> | null = null;

export function beginLive2DModelLoad(): number {
  if (state.status === "loading") {
    throw new Error("live2d_model_load_already_in_progress");
  }
  const generation = state.generation + 1;
  state = { generation, status: "loading", error: "" };
  currentPromise = new Promise<void>((resolve, reject) => {
    resolveCurrent = resolve;
    rejectCurrent = reject;
  });
  void currentPromise.catch((): void => {});
  return generation;
}

export function cancelLive2DModelLoad(
  generation: number,
  reason = "live2d_model_load_cancelled",
): boolean {
  if (generation !== state.generation || state.status !== "loading") {
    return false;
  }
  const message = reason.trim() || "live2d_model_load_cancelled";
  rejectCurrent?.(new Error(message));
  state = { generation, status: "idle", error: "" };
  resolveCurrent = null;
  rejectCurrent = null;
  currentPromise = null;
  return true;
}

export function cancelCurrentLive2DModelLoad(
  reason = "live2d_model_load_cancelled",
): boolean {
  return cancelLive2DModelLoad(state.generation, reason);
}

export function isLive2DModelLoadActive(generation: number): boolean {
  return generation === state.generation && state.status === "loading";
}

export function markLive2DModelReady(generation: number): void {
  if (generation !== state.generation || state.status !== "loading") {
    return;
  }
  state = { generation, status: "ready", error: "" };
  resolveCurrent?.();
  resolveCurrent = null;
  rejectCurrent = null;
}

export function markLive2DModelFailed(generation: number, reason: string): void {
  if (generation !== state.generation || state.status !== "loading") {
    return;
  }
  const message = reason.trim() || "live2d_model_load_failed";
  state = { generation, status: "error", error: message };
  rejectCurrent?.(new Error(message));
  resolveCurrent = null;
  rejectCurrent = null;
}

export function waitForLive2DModelLoad(generation: number): Promise<void> {
  if (generation !== state.generation || !currentPromise) {
    return Promise.reject(new Error("live2d_model_load_generation_mismatch"));
  }
  return currentPromise;
}

export function getLive2DModelLoadState(): Readonly<Live2DModelLoadState> {
  return state;
}
