export type DirectParameterPlanTerminalStatus =
  | "completed"
  | "stopped"
  | "failed"
  | "rejected";

export interface DirectParameterPlanTerminalEvent {
  runId: string;
  status: DirectParameterPlanTerminalStatus;
  reason?: string;
}

export interface DirectParameterPlanStartOptions {
  runId?: string;
  playbackClockReader?: { getElapsedMs: () => number | null };
  onTerminal?: (event: DirectParameterPlanTerminalEvent) => void;
}

export type DirectParameterCurvePreset =
  | "smooth_hold"
  | "snap_hold_soft_release"
  | "slow_build_quick_release"
  | "pulse_settle"
  | "breathing_swell";

export interface DirectParameterTrackPointInput {
  at_ms: number;
  transition_ms: number;
  target_value: number;
}

export interface DirectParameterModulationInput {
  kind: "speech_gesture_track";
  preset: "calm_explain" | "lively_chat" | "gentle_support" | "emphatic";
  amplitude: number;
  direction: 1 | -1;
  delay_ms: number;
  points: Array<{
    at_ms: number;
    transition_ms: number;
    value: number;
  }>;
}

export type DirectParameterResponsePolicy =
  | { kind: "bounded" }
  | {
      kind: "spring";
      frequency_hz: number;
      damping_ratio: number;
    };

export interface DirectParameterPlanEntryInput {
  axis_id: string;
  parameter_id: string;
  target_value: number;
  neutral_target_value: number;
  weight: number;
  keyframes?: DirectParameterTrackPointInput[];
  modulation?: DirectParameterModulationInput;
  dynamics: {
    max_velocity: number;
    max_acceleration: number;
    max_speech_offset: number;
    response: DirectParameterResponsePolicy;
  };
}

export interface DirectParameterPlanInput {
  profile_id: string;
  profile_revision: number;
  mode: "expressive" | "idle";
  emotion_label: string;
  resource?: {
    kind: "expression";
    expression_id: string;
  };
  timing: {
    duration_ms: number;
    blend_in_ms: number;
    hold_ms: number;
    blend_out_ms: number;
    curve_preset?: DirectParameterCurvePreset;
  };
  parameters: DirectParameterPlanEntryInput[];
}

export interface DirectParameterExecutionPlan {
  plan: DirectParameterPlanInput;
  timing: {
    durationMs: number;
    blendInMs: number;
    holdMs: number;
    blendOutMs: number;
    curvePreset: DirectParameterCurvePreset;
    totalMs: number;
  };
}
