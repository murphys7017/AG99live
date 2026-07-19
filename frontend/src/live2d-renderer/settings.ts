export interface Live2dRuntimeEffectsSettings {
  ambientMotionEnabled: boolean;
  physicsResponseScale: number;
}

export interface Live2dPresentationSettings extends Live2dRuntimeEffectsSettings {
  renderDprCap: number;
}

export const DEFAULT_PHYSICS_RESPONSE_SCALE = 1;
export const MIN_PHYSICS_RESPONSE_SCALE = 0.5;
export const MAX_PHYSICS_RESPONSE_SCALE = 2;
export const PHYSICS_RESPONSE_SCALE_STEP = 0.05;
export const DEFAULT_LIVE2D_RENDER_DPR_CAP = 1.25;
export const MIN_LIVE2D_RENDER_DPR_CAP = 1;
export const MAX_LIVE2D_RENDER_DPR_CAP = 2.5;
export const LIVE2D_RENDER_DPR_CAP_STEP = 0.25;

export function buildDefaultLive2dPresentationSettings(): Live2dPresentationSettings {
  return {
    ambientMotionEnabled: true,
    physicsResponseScale: DEFAULT_PHYSICS_RESPONSE_SCALE,
    renderDprCap: DEFAULT_LIVE2D_RENDER_DPR_CAP,
  };
}

export function normalizeLive2dPresentationSettings(
  value: unknown,
): Live2dPresentationSettings {
  const raw = value && typeof value === "object"
    ? value as Partial<Record<keyof Live2dPresentationSettings, unknown>>
    : {};
  return {
    ambientMotionEnabled: raw.ambientMotionEnabled !== false,
    physicsResponseScale: normalizeNumber(
      raw.physicsResponseScale,
      DEFAULT_PHYSICS_RESPONSE_SCALE,
      MIN_PHYSICS_RESPONSE_SCALE,
      MAX_PHYSICS_RESPONSE_SCALE,
    ),
    renderDprCap: normalizeNumber(
      raw.renderDprCap,
      DEFAULT_LIVE2D_RENDER_DPR_CAP,
      MIN_LIVE2D_RENDER_DPR_CAP,
      MAX_LIVE2D_RENDER_DPR_CAP,
    ),
  };
}

export function cloneLive2dPresentationSettings(
  value: unknown,
): Live2dPresentationSettings {
  return { ...normalizeLive2dPresentationSettings(value) };
}

export function applyLive2dPresentationSettingsSnapshot(
  target: Live2dPresentationSettings,
  value: unknown,
): void {
  const normalized = normalizeLive2dPresentationSettings(value);
  target.ambientMotionEnabled = normalized.ambientMotionEnabled;
  target.physicsResponseScale = normalized.physicsResponseScale;
  target.renderDprCap = normalized.renderDprCap;
}

export function selectLive2dRuntimeEffectsSettings(
  settings: Live2dPresentationSettings,
): Live2dRuntimeEffectsSettings {
  return {
    ambientMotionEnabled: settings.ambientMotionEnabled,
    physicsResponseScale: settings.physicsResponseScale,
  };
}

function normalizeNumber(
  value: unknown,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return defaultValue;
  }
  return Math.max(minimum, Math.min(maximum, Math.round(numeric * 100) / 100));
}
