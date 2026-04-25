import type {
  DirectParameterAxisName,
  DirectParameterPlan,
} from "../types/protocol";
import {
  DIRECT_PARAMETER_AXIS_NAMES,
  IDLE_DEADZONE_MAX,
  IDLE_DEADZONE_MIN,
} from "./constants";
import type { CompileOptions, CompileResult, MotionIntent } from "./contracts";
import {
  cloneModelEngineSettings,
  normalizeModelEngineSettings,
} from "./settings";
import { buildSupplementaryParams } from "./supplementary";
import { resolveMotionTiming } from "./timing";

type AxisValues = Record<DirectParameterAxisName, number>;

function buildAxisValues(intent: MotionIntent): AxisValues {
  const axisValues = {} as AxisValues;
  for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
    axisValues[axisName] = Number(intent.key_axes[axisName]?.value);
  }
  return axisValues;
}

function validateIntentForCompile(intent: MotionIntent): string {
  if (!intent.emotion_label.trim()) {
    return "emotion_label_empty";
  }
  for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
    const axisValue = Number(intent.key_axes[axisName]?.value);
    if (!Number.isFinite(axisValue)) {
      return `axis_value_not_number:${axisName}`;
    }
    if (axisValue < 0 || axisValue > 100) {
      return `axis_value_out_of_range:${axisName}`;
    }
  }
  return "";
}

function isIdleDeadzone(axisValues: AxisValues): boolean {
  return DIRECT_PARAMETER_AXIS_NAMES.every((axisName) => {
    const value = Number(axisValues[axisName] ?? 50);
    return value >= IDLE_DEADZONE_MIN && value <= IDLE_DEADZONE_MAX;
  });
}

function clampAxisValue(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function applyExpressiveIntensity(
  axisValues: AxisValues,
  options: CompileOptions,
): {
  axisValues: AxisValues;
  intensityApplied: boolean;
  motionIntensityScale: number;
  axisIntensityScale: Record<DirectParameterAxisName, number>;
} {
  const settings = normalizeModelEngineSettings(options.settings);
  const nextValues = {} as AxisValues;
  for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
    const baseValue = Number(axisValues[axisName] ?? 50);
    const axisScale = settings.axisIntensityScale[axisName];
    nextValues[axisName] = clampAxisValue(
      50 + (baseValue - 50) * settings.motionIntensityScale * axisScale,
    );
  }

  const intensityApplied = settings.motionIntensityScale !== 1
    || DIRECT_PARAMETER_AXIS_NAMES.some(
      (axisName) => settings.axisIntensityScale[axisName] !== 1,
    );
  return {
    axisValues: nextValues,
    intensityApplied,
    motionIntensityScale: settings.motionIntensityScale,
    axisIntensityScale: cloneModelEngineSettings(settings).axisIntensityScale,
  };
}

export function compileMotionIntent(
  intent: MotionIntent,
  options: CompileOptions,
): CompileResult {
  const normalizedSettings = normalizeModelEngineSettings(options.settings);
  const validationFailure = validateIntentForCompile(intent);
  if (validationFailure) {
    return {
      ok: false,
      plan: null,
      reason: validationFailure,
      diagnostics: {
        usedFallbackLibrary: false,
        supplementaryCount: 0,
        timingSource: "default",
        resolvedMode: "idle",
        source: options.source,
        intensityApplied: false,
        motionIntensityScale: normalizedSettings.motionIntensityScale,
        axisIntensityScale: { ...normalizedSettings.axisIntensityScale },
      },
    };
  }

  const rawAxisValues = buildAxisValues(intent);
  const expressiveIntensity = intent.mode === "expressive"
    ? applyExpressiveIntensity(rawAxisValues, options)
    : {
      axisValues: rawAxisValues,
      intensityApplied: false,
      motionIntensityScale: normalizedSettings.motionIntensityScale,
      axisIntensityScale: { ...normalizedSettings.axisIntensityScale },
    };
  const axisValues = expressiveIntensity.axisValues;
  const idleDeadzone = isIdleDeadzone(axisValues);
  if (intent.mode === "expressive" && idleDeadzone) {
    console.warn(
      "[ModelEngine] expressive intent resolved to idle because all axes are inside deadzone.",
      {
        emotion_label: intent.emotion_label,
        key_axes: intent.key_axes,
      },
    );
  }
  const resolvedMode: DirectParameterPlan["mode"] = intent.mode === "idle"
    ? "idle"
    : idleDeadzone
      ? "idle"
      : "expressive";
  const timing = resolveMotionTiming({
    mode: resolvedMode,
    durationHintMs: intent.duration_hint_ms ?? null,
    targetDurationMs: options.targetDurationMs ?? null,
  });

  const supplementary = resolvedMode === "expressive"
    ? buildSupplementaryParams(axisValues, options.model)
    : {
      params: [],
      diagnostics: {
        usedFallbackLibrary: false,
        selectedFrom: "none" as const,
      },
    };

  const plan: DirectParameterPlan = {
    schema_version: "engine.parameter_plan.v1",
    mode: resolvedMode,
    emotion_label: intent.emotion_label,
    timing: timing.timing,
    key_axes: {
      head_yaw: { value: axisValues.head_yaw },
      head_roll: { value: axisValues.head_roll },
      head_pitch: { value: axisValues.head_pitch },
      body_yaw: { value: axisValues.body_yaw },
      body_roll: { value: axisValues.body_roll },
      gaze_x: { value: axisValues.gaze_x },
      gaze_y: { value: axisValues.gaze_y },
      eye_open_left: { value: axisValues.eye_open_left },
      eye_open_right: { value: axisValues.eye_open_right },
      mouth_open: { value: axisValues.mouth_open },
      mouth_smile: { value: axisValues.mouth_smile },
      brow_bias: { value: axisValues.brow_bias },
    },
    supplementary_params: supplementary.params,
    model_calibration_profile: options.model.calibration_profile ?? undefined,
    summary: {
      key_axes_count: DIRECT_PARAMETER_AXIS_NAMES.length,
      supplementary_count: supplementary.params.length,
      target_duration_ms: timing.resolvedDurationMs,
    },
  };

  return {
    ok: true,
    plan,
    reason: "",
    diagnostics: {
      usedFallbackLibrary: supplementary.diagnostics.usedFallbackLibrary,
      supplementaryCount: supplementary.params.length,
      timingSource: timing.timingSource,
      resolvedMode,
      source: options.source,
      intensityApplied: expressiveIntensity.intensityApplied,
      motionIntensityScale: expressiveIntensity.motionIntensityScale,
      axisIntensityScale: expressiveIntensity.axisIntensityScale,
    },
  };
}
