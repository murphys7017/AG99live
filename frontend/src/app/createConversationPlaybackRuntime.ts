import { onScopeDispose } from "vue";
import {
  createAdapterConnection,
  type AdapterConnectionCompositionInstance,
  type AdapterConnectionInstance,
} from "../adapter-connection/useAdapterConnection.js";
import type { ModelSyncInstance } from "../adapter-connection/model-sync/useModelSync.js";
import { createBrowserAudioTimelineSink } from "../playback-timeline/audioSink.js";
import type { PlaybackTimelineSegmentMotionSink } from "../playback-timeline/segmentJob.js";
import type {
  MotionPayloadNormalizer,
  NormalizedMotionPayload,
} from "../playback-integrations/motionPayload.js";
import type { useTurnPlaybackSessionStore } from "../turn-playback/useTurnPlaybackSessionStore.js";
import {
  createAppPlaybackTimelineRuntime,
  type PlaybackTimelineWiringPort,
} from "./playbackTimelineWiring.js";

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

export interface ConversationPlaybackRuntime {
  adapter: AdapterConnectionInstance;
  playbackTimeline: PlaybackTimelineWiringPort;
  bindMotionTimelineSink: (
    motionSink: PlaybackTimelineSegmentMotionSink<NormalizedMotionPayload>,
  ) => void;
}

export function createConversationPlaybackRuntime(options: {
  sessionStore: SessionStore;
  modelSync: ModelSyncInstance;
  normalizeMotionPayload: MotionPayloadNormalizer;
}): ConversationPlaybackRuntime {
  let motionTimelineSink: PlaybackTimelineSegmentMotionSink<NormalizedMotionPayload> | null = null;
  const requiredMotionTimelineSink: PlaybackTimelineSegmentMotionSink<NormalizedMotionPayload> = {
    start(payload, context) {
      if (!motionTimelineSink) {
        throw new Error("ModelEngine motion timeline sink is not initialized.");
      }
      return motionTimelineSink.start(payload, context);
    },
    interrupt(turnId, messageId, reason) {
      if (!motionTimelineSink) {
        throw new Error("ModelEngine motion timeline sink is not initialized.");
      }
      motionTimelineSink.interrupt(turnId, messageId, reason);
    },
  };
  const adapter: AdapterConnectionCompositionInstance = createAdapterConnection({
    sessionStore: options.sessionStore,
    modelSync: options.modelSync,
    normalizeMotionPayload: options.normalizeMotionPayload,
  });
  const playbackTimeline = createAppPlaybackTimelineRuntime({
    sessionStore: options.sessionStore,
    adapterPlayback: adapter.playback,
    motionSink: requiredMotionTimelineSink,
    audioSink: createBrowserAudioTimelineSink(),
  });

  onScopeDispose(() => {
    motionTimelineSink = null;
    adapter.dispose();
  });

  return {
    adapter,
    playbackTimeline,
    bindMotionTimelineSink(nextSink) {
      if (motionTimelineSink) {
        throw new Error("ModelEngine motion timeline sink may only be bound once.");
      }
      motionTimelineSink = nextSink;
    },
  };
}
