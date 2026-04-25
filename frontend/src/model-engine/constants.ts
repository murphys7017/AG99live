import type { DirectParameterAxisName } from "../types/protocol";

export const DIRECT_PARAMETER_AXIS_NAMES = [
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
] as const satisfies readonly DirectParameterAxisName[];

export const DEFAULT_MOTION_INTENT_DURATION_MS = 1200;
export const MIN_MOTION_DURATION_MS = 320;
export const MAX_MOTION_DURATION_MS = 15000;
export const MOTION_SYNC_WAIT_FOR_AUDIO_MS = 420;
export const MOTION_MIN_REMAINING_AUDIO_MS = 260;
export const SUPPLEMENTARY_AXIS_THRESHOLD = 8;
export const SUPPLEMENTARY_MAX_COUNT = 4;
export const IDLE_DEADZONE_MIN = 42;
export const IDLE_DEADZONE_MAX = 58;

export const DEFAULT_AXIS_PARAMETER_EXCLUSIONS: Record<
  DirectParameterAxisName,
  string[]
> = {
  head_yaw: ["paramanglex", "param_angle_x"],
  head_roll: ["paramanglez", "param_angle_z"],
  head_pitch: ["paramangley", "param_angle_y"],
  body_yaw: ["parambodyanglex", "param_body_angle_x"],
  body_roll: [
    "parambodyanglez",
    "param_body_angle_z",
    "parambodyangley",
    "param_body_angle_y",
  ],
  gaze_x: ["parameyeballx", "param_eye_ball_x"],
  gaze_y: ["parameyebally", "param_eye_ball_y"],
  eye_open_left: ["parameyelopen", "param_eye_l_open"],
  eye_open_right: ["parameyeropen", "param_eye_r_open"],
  mouth_open: [
    "parammouthopeny",
    "param_mouth_open_y",
    "parammouthopen",
    "param_mouth_open",
  ],
  mouth_smile: ["parammouthsmile", "param_mouth_smile"],
  brow_bias: [
    "parambrowly",
    "param_brow_l_y",
    "parambrowry",
    "param_brow_r_y",
  ],
};
