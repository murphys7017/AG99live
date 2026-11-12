import { reactive } from "vue";
import type { DesktopRuntimeSettingsAccess } from "../adapter-connection/features/desktopSettings.js";
import { createModelSync } from "../adapter-connection/model-sync/useModelSync";
import { useDesktopBridge } from "../desktop-bridge/useDesktopBridge";
import { createWindowLive2dRuntimePort } from "../live2d/runtimePort.js";
import {
  applyLive2dPresentationSettingsSnapshot,
  cloneLive2dPresentationSettings,
  type Live2dPresentationSettings,
} from "../live2d-renderer/settings";
import { useTurnPlaybackSessionStore } from "../turn-playback/useTurnPlaybackSessionStore";
import type { TurnPlaybackSessionPort } from "../turn-playback/sessionStorePort.js";
import { normalizeMotionPayload } from "../model-engine/normalize";
import {
  applyModelEngineSettings,
  cloneModelEngineSettings,
} from "../model-engine/settings";
import type { ModelEngineSettings } from "../model-engine/settings";
import { createConversationPlaybackRuntime } from "./createConversationPlaybackRuntime";

export interface DesktopRuntimeFoundation {
  sessionStore: TurnPlaybackSessionPort;
  modelSync: ReturnType<typeof createModelSync>;
  live2dRuntime: ReturnType<typeof createWindowLive2dRuntimePort>;
  bridge: ReturnType<typeof useDesktopBridge>;
  motionEngineSettings: ModelEngineSettings;
  live2dPresentationSettings: Live2dPresentationSettings;
  desktopRuntimeSettings: DesktopRuntimeSettingsAccess;
  conversationPlayback: ReturnType<typeof createConversationPlaybackRuntime>;
}

export function createDesktopRuntimeFoundation(): DesktopRuntimeFoundation {
  const sessionStore = useTurnPlaybackSessionStore({ normalizeMotionPayload });
  const modelSync = createModelSync();
  const live2dRuntime = createWindowLive2dRuntimePort();
  const bridge = useDesktopBridge();
  const motionEngineSettings = reactive(
    cloneModelEngineSettings(bridge.state.snapshot.motionEngineSettings),
  );
  const live2dPresentationSettings = reactive(
    cloneLive2dPresentationSettings(
      bridge.state.snapshot.live2dPresentationSettings,
    ),
  );
  const desktopRuntimeSettings: DesktopRuntimeSettingsAccess = {
    currentAmbientMotionEnabled: () => live2dPresentationSettings.ambientMotionEnabled,
    applyAmbientMotionEnabled: (enabled) => {
      applyLive2dPresentationSettingsSnapshot(live2dPresentationSettings, {
        ...live2dPresentationSettings,
        ambientMotionEnabled: enabled,
      });
    },
    currentPhysicsResponseScale: () => live2dPresentationSettings.physicsResponseScale,
    applyPhysicsResponseScale: (scale) => {
      applyLive2dPresentationSettingsSnapshot(live2dPresentationSettings, {
        ...live2dPresentationSettings,
        physicsResponseScale: scale,
      });
    },
    currentRenderDprCap: () => live2dPresentationSettings.renderDprCap,
    applyRenderDprCap: (cap) => {
      applyLive2dPresentationSettingsSnapshot(live2dPresentationSettings, {
        ...live2dPresentationSettings,
        renderDprCap: cap,
      });
    },
    currentMotionIntensityScale: () => motionEngineSettings.motionIntensityScale,
    applyMotionIntensityScale: (scale) => {
      applyModelEngineSettings(motionEngineSettings, {
        ...motionEngineSettings,
        motionIntensityScale: scale,
      });
    },
  };
  const conversationPlayback = createConversationPlaybackRuntime({
    sessionStore,
    modelSync,
    normalizeMotionPayload,
    desktopRuntimeSettings,
    live2dRuntime,
  });

  return {
    sessionStore,
    modelSync,
    live2dRuntime,
    bridge,
    motionEngineSettings,
    live2dPresentationSettings,
    desktopRuntimeSettings,
    conversationPlayback,
  };
}
