import assert from "node:assert/strict";
import { createPlaybackTimelineRuntime } from "../src/playback-timeline/playbackTimelineRuntime.js";

const runtime = createPlaybackTimelineRuntime<unknown>({
  segmentExecution: {
    session: {
      markSessionFailed() {},
      markAudioReleased() {},
      markMotionReleased() {},
      markPhase() {
        return true;
      },
    },
    textSink: {
      releaseAssistantTextForPlayback() {
        return true;
      },
      failAssistantTextForPlayback() {
        return true;
      },
    },
    audioSink: {
      releaseAudioForPlayback() {
        return true;
      },
    },
    motionSink: {
      start() {
        return true;
      },
      interrupt() {},
    },
  },
});

const segment = { turnId: "turn-1", messageId: "segment-1" };
runtime.startAudioTimelineSink(segment.turnId, segment.messageId, {
  start: () => true,
});
assert.equal(
  runtime.ensureMotionTimelineSinkForSegment(segment.turnId, segment.messageId),
  true,
);
assert.equal(
  runtime.markAudioTimelineStarted(
    segment.turnId,
    segment.messageId,
    0,
    1000,
    {
      getCurrentTimeMs: () => 0,
      getDurationMs: () => 1000,
      getPlaybackRate: () => 1,
      isPlaying: () => true,
    },
  ),
  true,
);
runtime.markMotionTimelineStarted(segment.turnId, segment.messageId);
runtime.markAudioTimelineTerminal(
  segment.turnId,
  segment.messageId,
  "completed",
  "audio_completed",
);

assert.deepEqual(runtime.findPlaybackReleaseBlockers(), [segment]);

runtime.markMotionTimelineTerminal(
  segment.turnId,
  segment.messageId,
  "completed",
  "motion_completed",
);
assert.deepEqual(runtime.findPlaybackReleaseBlockers(), []);

runtime.stopAllTimelines("test_complete");
console.log("playback timeline runtime ordering smoke test passed");
