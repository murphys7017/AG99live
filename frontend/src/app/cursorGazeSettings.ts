import { reactive, readonly } from "vue";

export interface CursorGazeSettings {
  enabled: boolean;
  pollIntervalMs: number;
  dwellMs: number;
  stationaryDistancePx: number;
}

export const CURSOR_GAZE_SETTINGS_KEY = "ag99live:cursor-gaze-settings";

const DEFAULT_SETTINGS: Readonly<CursorGazeSettings> = {
  enabled: true,
  pollIntervalMs: 100,
  dwellMs: 450,
  stationaryDistancePx: 14,
};

const NUMBER_RANGES = {
  pollIntervalMs: [50, 1000],
  dwellMs: [100, 2000],
  stationaryDistancePx: [1, 100],
} as const;

let sharedState: CursorGazeSettings | null = null;
let sharedSettings: Readonly<CursorGazeSettings> | null = null;

function isValidNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum;
}

export function loadCursorGazeSettings(): CursorGazeSettings {
  const stored = window.localStorage.getItem(CURSOR_GAZE_SETTINGS_KEY);
  if (stored === null) return { ...DEFAULT_SETTINGS };
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<keyof CursorGazeSettings, unknown>>
    : {};
  const settings = { ...DEFAULT_SETTINGS };
  if (typeof raw.enabled === "boolean") settings.enabled = raw.enabled;
  for (const key of Object.keys(NUMBER_RANGES) as Array<keyof typeof NUMBER_RANGES>) {
    const [minimum, maximum] = NUMBER_RANGES[key];
    if (isValidNumber(raw[key], minimum, maximum)) settings[key] = raw[key];
  }
  return settings;
}

export function saveCursorGazeSetting(
  key: keyof CursorGazeSettings,
  value: unknown,
): CursorGazeSettings {
  const settings = loadCursorGazeSettings();
  if (key === "enabled") {
    if (typeof value !== "boolean") throw new TypeError("Cursor gaze enabled must be boolean.");
    settings.enabled = value;
  } else {
    const range = NUMBER_RANGES[key];
    if (!range || !isValidNumber(value, range[0], range[1])) {
      throw new RangeError(`Invalid cursor gaze setting: ${key}.`);
    }
    settings[key] = value;
  }
  const oldValue = window.localStorage.getItem(CURSOR_GAZE_SETTINGS_KEY);
  const newValue = JSON.stringify(settings);
  window.localStorage.setItem(CURSOR_GAZE_SETTINGS_KEY, newValue);
  if (sharedState) Object.assign(sharedState, settings);
  if (oldValue !== newValue) {
    window.dispatchEvent(new StorageEvent("storage", {
      key: CURSOR_GAZE_SETTINGS_KEY,
      oldValue,
      newValue,
      storageArea: window.localStorage,
      url: window.location.href,
    }));
  }
  return settings;
}

export function useCursorGazeSettings(): Readonly<CursorGazeSettings> {
  if (sharedSettings) return sharedSettings;
  const state = reactive(loadCursorGazeSettings());
  sharedState = state;
  sharedSettings = readonly(state);
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== CURSOR_GAZE_SETTINGS_KEY) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    Object.assign(state, loadCursorGazeSettings());
  });
  return sharedSettings;
}
