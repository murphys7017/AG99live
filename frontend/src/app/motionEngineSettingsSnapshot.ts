import {
  cloneModelEngineSettings,
  modelEngineSettingsEqual,
  normalizeModelEngineSettings,
  type ModelEngineSettings,
} from "../model-engine/settings";

export function applyMotionEngineSettingsSnapshot(
  target: ModelEngineSettings,
  nextValue: unknown,
): void {
  const normalized = normalizeModelEngineSettings(nextValue);
  const currentSettings = cloneModelEngineSettings(target);
  if (modelEngineSettingsEqual(currentSettings, normalized)) {
    return;
  }
  target.motionIntensityScale = normalized.motionIntensityScale;
  target.live2dRenderDprCap = normalized.live2dRenderDprCap;
  target.axisIntensityScale = {
    ...normalized.axisIntensityScale,
  };
}
