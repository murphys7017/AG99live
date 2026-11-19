export const DEFAULT_MOTION_INTENT_DURATION_MS = 1000;
// Automatic speech gestures leave most of the torso range for explicit poses.
export const SPEECH_BODY_FOLLOW_SCALE = 0.4;
export const MIN_MOTION_DURATION_MS = 320;
export const MAX_MOTION_DURATION_MS = 15000;
// Foreground semantic actions can use a longer sparse sequence. Ambient
// sources keep their own smaller admission limit below.
export const MIN_MOTION_SEQUENCE_STEPS = 1;
export const MAX_MOTION_SEQUENCE_STEPS = 8;
export const MAX_IDLE_MOTION_STEPS = 4;
// This is the compiler's per-parameter track capacity, not the ambient
// admission limit.
export const MIN_PARAMETER_KEYFRAME_COUNT = 2;
export const MAX_PARAMETER_KEYFRAME_COUNT = MAX_MOTION_SEQUENCE_STEPS + 1; // Includes the initial activation point.
// Model-engine wait budget: an audio-synced motion payload must receive a
// matching playback timeline within this window, otherwise it fails visibly.
// This is separate from the orchestrator's wider startup aggregation window.
export const MOTION_MIN_REMAINING_AUDIO_MS = 260;
