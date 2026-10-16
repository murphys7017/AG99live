import assert from "node:assert/strict";

import { parseDesktopLatencyEvent } from "../electron/shared/desktop-latency-event.js";

const validCapture = {
  type: "audio_capture_ended",
  turnId: "input:turn-1",
  streamId: "mic:stream-1",
  captureMode: "ptt",
  reason: "ptt_release",
  dropped: false,
  captureEndedAtMonotonicMs: 42.5,
  timestampEpochMs: 1_792_060_945_657,
  transcript: "must not persist",
};

assert.deepEqual(parseDesktopLatencyEvent(validCapture), {
  type: "audio_capture_ended",
  turnId: "input:turn-1",
  streamId: "mic:stream-1",
  captureMode: "ptt",
  reason: "ptt_release",
  dropped: false,
  captureEndedAtMonotonicMs: 42.5,
  timestampEpochMs: 1_792_060_945_657,
});

assert.deepEqual(
  parseDesktopLatencyEvent({
    type: "audio_playback_started",
    turnId: "input:turn-1",
    durationMs: 1600,
    startedAtMonotonicMs: 85.25,
    timestampEpochMs: 1_792_060_945_700,
  }),
  {
    type: "audio_playback_started",
    turnId: "input:turn-1",
    durationMs: 1600,
    startedAtMonotonicMs: 85.25,
    timestampEpochMs: 1_792_060_945_700,
  },
);

assert.equal(
  parseDesktopLatencyEvent({
    ...validCapture,
    timestampEpochMs: Number.POSITIVE_INFINITY,
  }),
  null,
);
assert.equal(parseDesktopLatencyEvent({ type: "unrecognized" }), null);

const stage = {
  type: "pipeline_stage", stage: "screenshot_end", turnId: "input:turn-1",
  streamId: "mic:stream-1", messageId: null, monotonicMs: 100, timeOriginMs: 1000, timestampEpochMs: 1100,
};
assert.deepEqual(parseDesktopLatencyEvent({ ...stage, transcript: "private" }), stage);
assert.equal(parseDesktopLatencyEvent({ ...stage, stage: "arbitrary private data" }), null);

console.log("Desktop latency event boundary tests passed.");
