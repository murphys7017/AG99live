import type { DirectParameterAxisName } from "../types/protocol";
import { DIRECT_PARAMETER_AXIS_NAMES } from "./constants";

export interface ModelEngineSettings {
  motionIntensityScale: number;
  axisIntensityScale: Record<DirectParameterAxisName, number>;
}

export const DEFAULT_MOTION_INTENSITY_SCALE = 1.35;
export const MIN_MOTION_INTENSITY_SCALE = 0.5;
export const MAX_MOTION_INTENSITY_SCALE = 2.5;
export const MOTION_INTENSITY_SCALE_STEP = 0.05;

export const MIN_AXIS_INTENSITY_SCALE = 0;
export const MAX_AXIS_INTENSITY_SCALE = 2.5;
export const AXIS_INTENSITY_SCALE_STEP = 0.05;

export const MOTION_AXIS_LABELS: Record<DirectParameterAxisName, string> = {
  head_yaw: "头部左右转向",
  head_roll: "头部左右歪斜",
  head_pitch: "头部上下俯仰",
  body_yaw: "身体左右转向",
  body_roll: "身体侧倾摆动",
  gaze_x: "视线左右",
  gaze_y: "视线上下",
  eye_open_left: "左眼开合",
  eye_open_right: "右眼开合",
  mouth_open: "嘴巴张合",
  mouth_smile: "微笑幅度",
  brow_bias: "眉毛情绪",
};

export function buildDefaultAxisIntensityScale():
  Record<DirectParameterAxisName, number> {
  const result = {} as Record<DirectParameterAxisName, number>;
  for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
    result[axisName] = 1;
  }
  return result;
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
): Record<DirectParameterAxisName, number> {
  const raw = value && typeof value === "object"
    ? value as Partial<Record<DirectParameterAxisName, unknown>>
    : {};
  const result = {} as Record<DirectParameterAxisName, number>;
  for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
    result[axisName] = normalizeScale(
      raw[axisName],
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
