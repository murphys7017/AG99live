import assert from "node:assert/strict";
import { ref } from "vue";
import { useMotionPlaybackRecorder } from "../src/playback-integrations/useMotionPlaybackRecorder.js";
import type { ModelEnginePlanStartedEvent } from "../src/model-engine/runtime/contracts.js";

const baseEvent = {
  model: null,
  messageId: "message-1",
  turnId: "turn-1",
  playbackTurnId: "turn-1",
  startReason: "audio_started",
  queuedDelayMs: 0,
  payloadKind: "semantic_plan",
  diagnostics: null,
  playerMessage: "hello",
  runId: "run-1",
  plan: {
    schema_version: "engine.parameter_plan.v2",
    profile_id: "profile-1",
    profile_revision: 1,
    model_id: "model-1",
    mode: "expressive",
    emotion_label: "happy",
    timing: {
      duration_ms: 1000,
      blend_in_ms: 100,
      hold_ms: 700,
      blend_out_ms: 200,
    },
    parameters: [{
      axis_id: "head_yaw",
      parameter_id: "ParamAngleX",
      target_value: 10,
      weight: 1,
    }],
  },
  motion: null,
} as unknown as ModelEnginePlanStartedEvent;

function createRecorder() {
  const rawEvents: Array<{
    event_type: string;
    message_id?: string;
    raw: Record<string, unknown>;
    turnId?: string | null;
  }> = [];
  const recorder = useMotionPlaybackRecorder({
    motionRecord: {
      getLastAssistantText: () => "assistant text",
      getSelectedModel: () => ref(null),
    },
    getPlaybackTimelineSnapshot: (turnId, messageId) => ({
      timelineId: "timeline-1",
      turnId,
      messageId,
      phase: "playing",
      clockSource: "audio",
      startedAtMs: 100,
      currentTimeMs: 900,
      durationMs: 1000,
      playbackRate: 1,
      sinks: [
        { id: "audio", required: true, terminal: "completed" },
        { id: "lip_sync", required: false, terminal: "completed" },
        { id: "motion", required: true, terminal: "started" },
      ],
    }),
    onMotionLabRawEvent: (payload, turnId) => {
      rawEvents.push({ ...payload, turnId });
    },
  });
  return { recorder, rawEvents };
}

function testRecordsPlaybackWithoutSessionWrites(): void {
  const { recorder, rawEvents } = createRecorder();
  recorder.recordMotionPlayback(baseEvent);

  assert.equal(recorder.motionPlaybackRecords.value.length, 1);
  assert.equal(recorder.motionPlaybackRecords.value[0]?.messageId, "message-1");
  assert.deepEqual(rawEvents.map((event) => event.event_type), [
    "motion.playback_started",
  ]);
}

function testIgnoresStaleTerminalAndRecordsMatchingTerminal(): void {
  const { recorder, rawEvents } = createRecorder();
  recorder.recordMotionPlayback(baseEvent);
  recorder.completeMotionPlayback({ runId: "stale", status: "completed" });
  assert.equal(rawEvents.length, 1);

  recorder.completeMotionPlayback({ runId: "run-1", status: "completed" });
  assert.equal(rawEvents[1]?.event_type, "motion.playback_completed");
  assert.equal(rawEvents[1]?.message_id, "message-1");
  assert.deepEqual(rawEvents[1]?.raw.timeline_outcome, {
    motion: "completed",
    reason: "",
    timeline_phase: "playing",
    clock_source: "audio",
    sinks: {
      audio: { required: true, terminal: "completed", reason: "" },
      lip_sync: { required: false, terminal: "completed", reason: "" },
      motion: { required: true, terminal: "completed", reason: "" },
    },
  });
}

function testPreviewDoesNotEnterHistory(): void {
  const { recorder, rawEvents } = createRecorder();
  recorder.recordMotionPlayback({ ...baseEvent, startReason: "preview" });
  assert.equal(recorder.motionPlaybackRecords.value.length, 0);
  assert.equal(rawEvents.length, 0);
}

testRecordsPlaybackWithoutSessionWrites();
testIgnoresStaleTerminalAndRecordsMatchingTerminal();
testPreviewDoesNotEnterHistory();
console.log("motionPlaybackRecorder tests passed");
