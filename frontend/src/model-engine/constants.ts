export const DEFAULT_MOTION_INTENT_DURATION_MS = 1000;
export const MIN_MOTION_DURATION_MS = 320;
export const MAX_MOTION_DURATION_MS = 15000;
// Model-engine wait budget: an audio-synced motion payload must receive a
// matching playback timeline within this window, otherwise it fails visibly.
// This is separate from the orchestrator's wider startup aggregation window.
export const MOTION_MIN_REMAINING_AUDIO_MS = 260;
