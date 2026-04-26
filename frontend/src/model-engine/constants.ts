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
] as const;

export const DEFAULT_MOTION_INTENT_DURATION_MS = 1200;
export const MIN_MOTION_DURATION_MS = 320;
export const MAX_MOTION_DURATION_MS = 15000;
export const MOTION_SYNC_WAIT_FOR_AUDIO_MS = 420;
export const MOTION_MIN_REMAINING_AUDIO_MS = 260;
