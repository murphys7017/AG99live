const DIRECT_PARAMETER_AXIS_NAMES = [
  "head_yaw",
  "head_roll",
  "head_pitch",
  "body_yaw",
  "body_roll",
  "gaze_x",
  "gaze_y",
  "eye_open_left",
  "eye_open_right",
  "mouth_open",
  "mouth_smile",
  "brow_bias",
] as const;

export interface ModelEngineSettings {
  motionIntensityScale: number;
  axisIntensityScale: Record<string, number>;
}

export const DEFAULT_MOTION_INTENSITY_SCALE = 1.35;
export const MIN_MOTION_INTENSITY_SCALE = 0.5;
export const MAX_MOTION_INTENSITY_SCALE = 2.5;
export const MOTION_INTENSITY_SCALE_STEP = 0.05;

export const MIN_AXIS_INTENSITY_SCALE = 0;
export const MAX_AXIS_INTENSITY_SCALE = 2.5;

export function buildDefaultAxisIntensityScale(): Record<string, number> {
  return Object.fromEntries(
    DIRECT_PARAMETER_AXIS_NAMES.map((axisName) => [axisName, 1]),
  );
}

export function buildDefaultModelEngineSettings(): ModelEngineSettings {
  return {
    motionIntensityScale: DEFAULT_MOTION_INTENSITY_SCALE,
    axisIntensityScale: buildDefaultAxisIntensityScale(),
  };
}

function normalizeScale(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(numeric * 100) / 100));
}

export function normalizeMotionIntensityScale(value: unknown): number {
  return normalizeScale(
    value,
    DEFAULT_MOTION_INTENSITY_SCALE,
    MIN_MOTION_INTENSITY_SCALE,
    MAX_MOTION_INTENSITY_SCALE,
  );
}

export function normalizeAxisIntensityScale(
  value: unknown,
): Record<string, number> {
  const raw = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const result = buildDefaultAxisIntensityScale();
  for (const key of Object.keys(raw)) {
    result[key] = normalizeScale(
      raw[key],
      result[key] ?? 1,
      MIN_AXIS_INTENSITY_SCALE,
      MAX_AXIS_INTENSITY_SCALE,
    );
  }
  return result;
}

export function normalizeModelEngineSettings(value: unknown): ModelEngineSettings {
  const raw = value && typeof value === "object"
    ? value as {
      motionIntensityScale?: unknown;
      axisIntensityScale?: unknown;
    }
    : {};
  return {
    motionIntensityScale: normalizeMotionIntensityScale(raw.motionIntensityScale),
    axisIntensityScale: normalizeAxisIntensityScale(raw.axisIntensityScale),
  };
}

export function cloneModelEngineSettings(
  settings: ModelEngineSettings,
): ModelEngineSettings {
  return {
    motionIntensityScale: settings.motionIntensityScale,
    axisIntensityScale: { ...settings.axisIntensityScale },
  };
}

export function modelEngineSettingsEqual(
  left: ModelEngineSettings,
  right: ModelEngineSettings,
): boolean {
  if (left.motionIntensityScale !== right.motionIntensityScale) {
    return false;
  }

  const keys = new Set([
    ...Object.keys(left.axisIntensityScale),
    ...Object.keys(right.axisIntensityScale),
  ]);
  for (const key of keys) {
    if ((left.axisIntensityScale[key] ?? 1) !== (right.axisIntensityScale[key] ?? 1)) {
      return false;
    }
  }

  return true;
}
