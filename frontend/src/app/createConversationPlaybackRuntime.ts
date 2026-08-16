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
} from "../types/motion.js";
import type { useTurnPlaybackSessionStore } from "../turn-playback/useTurnPlaybackSessionStore.js";
import {
  createAppPlaybackTimelineRuntime,
  type configurePlaybackTimelineMotionRuntime,
  type PlaybackTimelineWiringPort,
} from "./playbackTimelineWiring.js";

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;
type PlaybackTimelineMotionRuntime = ReturnType<
  typeof configurePlaybackTimelineMotionRuntime
>;

export interface ConversationPlaybackRuntime {
  adapter: AdapterConnectionInstance;
  playbackTimeline: PlaybackTimelineWiringPort;
  dispose: () => Promise<void>;
  bindMotionTimelineRuntime: (
    motionRuntime: PlaybackTimelineMotionRuntime,
  ) => void;
}

export function createConversationPlaybackRuntime(options: {
  sessionStore: SessionStore;
  modelSync: ModelSyncInstance;
  normalizeMotionPayload: MotionPayloadNormalizer;
}): ConversationPlaybackRuntime {
  let motionRuntime: PlaybackTimelineMotionRuntime | null = null;
  function requireMotionRuntime(): PlaybackTimelineMotionRuntime {
    if (!motionRuntime) {
      throw new Error("ModelEngine motion runtime is not initialized.");
    }
    return motionRuntime;
  }
  const requiredMotionTimelineSink: PlaybackTimelineSegmentMotionSink<NormalizedMotionPayload> = {
    start(payload, context) {
      return requireMotionRuntime().motionTimelineSink.start(payload, context);
    },
    interrupt(turnId, messageId, reason) {
      requireMotionRuntime().motionTimelineSink.interrupt(turnId, messageId, reason);
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
    onAudioTimelineStarted: (turnId, messageId, timeline) => {
      requireMotionRuntime().handleAudioTimelineStarted(turnId, messageId, timeline);
    },
    onAudioTimelineDurationReady: (turnId, messageId, timeline) => {
      requireMotionRuntime().handleAudioTimelineDurationReady(
        turnId,
        messageId,
        timeline,
      );
    },
  });

  onScopeDispose(() => {
    void dispose().catch((error) => {
      console.error("[ConversationPlaybackRuntime] adapter dispose failed.", error);
    });
  });

  async function dispose(): Promise<void> {
    await adapter.dispose();
    motionRuntime = null;
  }

  return {
    adapter,
    playbackTimeline,
    dispose,
    bindMotionTimelineRuntime(nextRuntime) {
      if (motionRuntime) {
        throw new Error("ModelEngine motion runtime may only be bound once.");
      }
      motionRuntime = nextRuntime;
    },
  };
}
