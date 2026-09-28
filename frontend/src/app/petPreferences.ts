export const SPEECH_VOLUME_KEY = "ag99live:speech-volume";
export const MODEL_VIEW_SCALE_KEY = "ag99live:model-view-scale";
export const MIN_MODEL_VIEW_SCALE = 0.8;
export const MAX_MODEL_VIEW_SCALE = 2;
export const DEFAULT_MODEL_VIEW_SCALE = 1;

function readNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function loadSpeechVolume(): number {
  return readNumber(SPEECH_VOLUME_KEY, 1, 0, 1);
}

export function saveSpeechVolume(value: number): void {
  window.localStorage.setItem(SPEECH_VOLUME_KEY, String(Math.max(0, Math.min(1, value))));
}

export function loadModelViewScale(): number {
  return readNumber(
    MODEL_VIEW_SCALE_KEY, DEFAULT_MODEL_VIEW_SCALE,
    MIN_MODEL_VIEW_SCALE, MAX_MODEL_VIEW_SCALE,
  );
}

export function saveModelViewScale(value: number): void {
  window.localStorage.setItem(
    MODEL_VIEW_SCALE_KEY,
    String(Math.max(MIN_MODEL_VIEW_SCALE, Math.min(MAX_MODEL_VIEW_SCALE, value))),
  );
}
