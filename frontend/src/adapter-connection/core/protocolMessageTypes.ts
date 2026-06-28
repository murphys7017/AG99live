export const INBOUND_MESSAGE_TYPES = {
  SYSTEM_SERVER_INFO: "system.server_info",
  SYSTEM_MODEL_SYNC: "system.model_sync",
  SYSTEM_SEMANTIC_AXIS_PROFILE_SAVED: "system.semantic_axis_profile_saved",
  SYSTEM_SEMANTIC_AXIS_PROFILE_SAVE_FAILED: "system.semantic_axis_profile_save_failed",
  SYSTEM_MOTION_TUNING_SAMPLES_STATE: "system.motion_tuning_samples_state",
  SYSTEM_HISTORY_LIST: "system.history_list",
  SYSTEM_HISTORY_CREATED: "system.history_created",
  SYSTEM_HISTORY_DATA: "system.history_data",
  SYSTEM_HISTORY_DELETED: "system.history_deleted",
  OUTPUT_TEXT: "output.text",
  OUTPUT_AUDIO: "output.audio",
  OUTPUT_IMAGE: "output.image",
  OUTPUT_TRANSCRIPTION: "output.transcription",
  CONTROL_TURN_STARTED: "control.turn_started",
  CONTROL_TURN_FINISHED: "control.turn_finished",
  CONTROL_INTERRUPT: "control.interrupt",
  CONTROL_START_MIC: "control.start_mic",
  CONTROL_SYNTH_FINISHED: "control.synth_finished",
  CONTROL_ERROR: "control.error",
  ENGINE_MOTION_INTENT: "engine.motion_intent",
  ENGINE_CATALOG_MOTION: "engine.catalog_motion",
  ENGINE_MOTION_PREVIEW: "engine.motion_preview",
  ENGINE_PERFORMANCE_CURVE_HINT: "engine.performance_curve_hint",
} as const;

export const OUTBOUND_MESSAGE_TYPES = {
  INPUT_TEXT: "input.text",
  INPUT_AUDIO_STREAM_START: "input.audio_stream_start",
  INPUT_AUDIO_STREAM_END: "input.audio_stream_end",
  INPUT_RAW_AUDIO_DATA: "input.raw_audio_data",
  INPUT_MIC_AUDIO_END: "input.mic_audio_end",
  CONTROL_INTERRUPT: "control.interrupt",
  CONTROL_PLAYBACK_FINISHED: "control.playback_finished",
  SYSTEM_SEMANTIC_AXIS_PROFILE_SAVE: "system.semantic_axis_profile_save",
  SYSTEM_HISTORY_LIST_REQUEST: "system.history_list_request",
  SYSTEM_HISTORY_CREATE: "system.history_create",
  SYSTEM_HISTORY_LOAD: "system.history_load",
  SYSTEM_HISTORY_DELETE: "system.history_delete",
  SYSTEM_MOTION_TUNING_SAMPLE_SAVE: "system.motion_tuning_sample_save",
  SYSTEM_MOTION_TUNING_SAMPLE_DELETE: "system.motion_tuning_sample_delete",
  SYSTEM_MOTION_LAB_RAW_EVENT: "system.motion_lab_raw_event",
  ENGINE_MOTION_INTENT: "engine.motion_intent",
  ENGINE_CATALOG_MOTION: "engine.catalog_motion",
} as const;

export type InboundMessageType =
  (typeof INBOUND_MESSAGE_TYPES)[keyof typeof INBOUND_MESSAGE_TYPES];

export type OutboundMessageType =
  (typeof OUTBOUND_MESSAGE_TYPES)[keyof typeof OUTBOUND_MESSAGE_TYPES];
