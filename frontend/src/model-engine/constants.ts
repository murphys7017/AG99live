export const DIRECT_PARAMETER_AXIS_NAMES = [
  "head_yaw",
  "head_roll",
  "head_pitch",
  "body_yaw",
  "body_roll",
  "body_pitch",
  "eye_open_left",
  "eye_open_right",
  "eye_smile_left",
  "eye_smile_right",
  "gaze_x",
  "gaze_y",
  "mouth_smile",
  "mouth_x",
  "brow_bias",
  "brow_left_detail",
  "brow_right_detail",
  "mouth_open",
  "breath",
] as const;

export const DEFAULT_MOTION_INTENT_DURATION_MS = 1200;
export const MIN_MOTION_DURATION_MS = 320;
export const MAX_MOTION_DURATION_MS = 15000;
// Model-engine fallback: once a motion payload arrives before audio, keep it in a
// shorter local wait buffer. This is separate from the orchestrator's wider
// startup aggregation window because the engine is only deciding whether an
// already-received motion payload should keep waiting for audio.
export const MOTION_SYNC_WAIT_FOR_AUDIO_MS = 420;
export const MOTION_MIN_REMAINING_AUDIO_MS = 260;
