export const DESKTOP_LATENCY_STAGES = [
  "capture_start", "capture_stop_requested", "capture_runtime_stopped",
  "audio_end_queue_ready", "screenshot_start", "screenshot_end", "audio_end_sent",
  "audio_prepare_start", "audio_prepare_end", "audio_started", "audio_ended",
  "output_warmup_start", "output_warmup_ready", "output_warmup_failed",
  "motion_started", "motion_ended", "motion_handoff",
  "incremental_text_first", "incremental_pcm_first",
  "pcm_prepare_start", "pcm_prepare_end", "pcm_first_sample", "pcm_drained",
] as const;
export type DesktopLatencyStage = typeof DESKTOP_LATENCY_STAGES[number];
