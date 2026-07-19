export interface ModelEngineSettings {
  motionIntensityScale: number;
}

export const DEFAULT_MOTION_INTENSITY_SCALE = 1.35;
export const MIN_MOTION_INTENSITY_SCALE = 0.5;
export const MAX_MOTION_INTENSITY_SCALE = 2.5;
export const MOTION_INTENSITY_SCALE_STEP = 0.05;
export function buildDefaultModelEngineSettings(): ModelEngineSettings {
  return {
    motionIntensityScale: DEFAULT_MOTION_INTENSITY_SCALE,
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

export function normalizeModelEngineSettings(value: unknown): ModelEngineSettings {
  const raw = value && typeof value === "object"
    ? value as {
      motionIntensityScale?: unknown;
    }
    : {};
  return {
    motionIntensityScale: normalizeMotionIntensityScale(raw.motionIntensityScale),
  };
}

export function cloneModelEngineSettings(
  settings: Partial<ModelEngineSettings>,
): ModelEngineSettings {
  const normalized = normalizeModelEngineSettings(settings);
  return {
    motionIntensityScale: normalized.motionIntensityScale,
  };
}

export function applyModelEngineSettings(
  target: ModelEngineSettings,
  value: unknown,
): void {
  const normalized = normalizeModelEngineSettings(value);
  target.motionIntensityScale = normalized.motionIntensityScale;
}
