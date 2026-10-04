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

function notifyPreferenceChanged(key: string, oldValue: string | null, newValue: string): void {
  // Browser storage events only reach other documents. The Web control page
  // shares this document with the running renderer, so notify its existing
  // storage listeners explicitly after a local write.
  window.dispatchEvent(new StorageEvent("storage", {
    key,
    oldValue,
    newValue,
    storageArea: window.localStorage,
    url: window.location.href,
  }));
}

export function loadSpeechVolume(): number {
  return readNumber(SPEECH_VOLUME_KEY, 1, 0, 1);
}

export function saveSpeechVolume(value: number): void {
  const nextValue = String(Math.max(0, Math.min(1, value)));
  const oldValue = window.localStorage.getItem(SPEECH_VOLUME_KEY);
  window.localStorage.setItem(SPEECH_VOLUME_KEY, nextValue);
  if (oldValue !== nextValue) {
    notifyPreferenceChanged(SPEECH_VOLUME_KEY, oldValue, nextValue);
  }
}

export function loadModelViewScale(): number {
  return readNumber(
    MODEL_VIEW_SCALE_KEY, DEFAULT_MODEL_VIEW_SCALE,
    MIN_MODEL_VIEW_SCALE, MAX_MODEL_VIEW_SCALE,
  );
}

export function saveModelViewScale(value: number): void {
  const nextValue = String(Math.max(MIN_MODEL_VIEW_SCALE, Math.min(MAX_MODEL_VIEW_SCALE, value)));
  const oldValue = window.localStorage.getItem(MODEL_VIEW_SCALE_KEY);
  window.localStorage.setItem(
    MODEL_VIEW_SCALE_KEY,
    nextValue,
  );
  if (oldValue !== nextValue) {
    notifyPreferenceChanged(MODEL_VIEW_SCALE_KEY, oldValue, nextValue);
  }
}
