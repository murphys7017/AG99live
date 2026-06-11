export interface ModelEngineSettings {
  motionIntensityScale: number;
  axisIntensityScale: Record<string, number>;
  live2dRenderDprCap: number;
}

export const DEFAULT_MOTION_INTENSITY_SCALE = 1.35;
export const MIN_MOTION_INTENSITY_SCALE = 0.5;
export const MAX_MOTION_INTENSITY_SCALE = 2.5;
export const MOTION_INTENSITY_SCALE_STEP = 0.05;
export const DEFAULT_LIVE2D_RENDER_DPR_CAP = 1.25;
export const MIN_LIVE2D_RENDER_DPR_CAP = 1;
export const MAX_LIVE2D_RENDER_DPR_CAP = 2.5;
export const LIVE2D_RENDER_DPR_CAP_STEP = 0.25;

export const MIN_AXIS_INTENSITY_SCALE = 0;
export const MAX_AXIS_INTENSITY_SCALE = 2.5;

export function buildDefaultAxisIntensityScale(): Record<string, number> {
  return {};
}

export function buildDefaultModelEngineSettings(): ModelEngineSettings {
  return {
    motionIntensityScale: DEFAULT_MOTION_INTENSITY_SCALE,
    axisIntensityScale: buildDefaultAxisIntensityScale(),
    live2dRenderDprCap: DEFAULT_LIVE2D_RENDER_DPR_CAP,
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

export function normalizeLive2dRenderDprCap(value: unknown): number {
  return normalizeScale(
    value,
    DEFAULT_LIVE2D_RENDER_DPR_CAP,
    MIN_LIVE2D_RENDER_DPR_CAP,
    MAX_LIVE2D_RENDER_DPR_CAP,
  );
}

export function normalizeAxisIntensityScale(
  value: unknown,
): Record<string, number> {
  const raw = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const result: Record<string, number> = {};
  for (const key of Object.keys(raw)) {
    result[key] = normalizeScale(
      raw[key],
      1,
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
      live2dRenderDprCap?: unknown;
    }
    : {};
  return {
    motionIntensityScale: normalizeMotionIntensityScale(raw.motionIntensityScale),
    axisIntensityScale: normalizeAxisIntensityScale(raw.axisIntensityScale),
    live2dRenderDprCap: normalizeLive2dRenderDprCap(raw.live2dRenderDprCap),
  };
}

export function cloneModelEngineSettings(
  settings: Partial<ModelEngineSettings>,
): ModelEngineSettings {
  const normalized = normalizeModelEngineSettings(settings);
  return {
    motionIntensityScale: normalized.motionIntensityScale,
    axisIntensityScale: { ...normalized.axisIntensityScale },
    live2dRenderDprCap: normalized.live2dRenderDprCap,
  };
}

export function modelEngineSettingsEqual(
  left: ModelEngineSettings,
  right: ModelEngineSettings,
): boolean {
  if (left.motionIntensityScale !== right.motionIntensityScale) {
    return false;
  }
  if (left.live2dRenderDprCap !== right.live2dRenderDprCap) {
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
