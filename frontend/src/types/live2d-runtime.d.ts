import type {
  DirectParameterPlanInput,
  DirectParameterPlanStartOptions,
  DirectParameterPlanTerminalStatus,
} from "../live2d/WebSDK/src/directparameterplan";

export type {
  DirectParameterPlanTerminalEvent,
  DirectParameterPlanTerminalStatus,
} from "../live2d/WebSDK/src/directparameterplan";

export interface CatalogMotionLifecycleCallbacks {
  playbackClockReader?: { getElapsedMs: () => number | null };
  onStarted?: () => void;
  onFinished?: () => void;
  onFailed?: (reason: string) => void;
  onInterrupted?: (reason: string) => void;
}

export {};

declare global {
  interface Window {
    Live2DCubismCore?: unknown;
    initializeLive2D?: () => void;
    getLAppAdapter?: () => {
      startMotion?: (
        group: string,
        no: number,
        priority: number,
        callbacks?: CatalogMotionLifecycleCallbacks,
      ) => unknown;
      stopMotion?: (reason?: string) => void;
      getMotionStartError?: () => string;
      applyRuntimeEffectsSettings: (settings: {
        ambientMotionEnabled: boolean;
        physicsResponseScale: number;
        protectedPhysicsOutputParameterIds: string[];
      }) => void;
      startDirectParameterPlan?: (
        plan: DirectParameterPlanInput,
        options?: DirectParameterPlanStartOptions,
      ) => boolean;
      stopDirectParameterPlan?: (reason?: string, status?: DirectParameterPlanTerminalStatus) => void;
      getDirectParameterPlanError?: () => string;
      beginExternalAudioSignalSource?: (
        sourceId: string,
        options?: { onFailed?: (reason: string) => void },
      ) => void;
      writeExternalAudioSignalSource?: (
        sourceId: string,
        values: { lipSyncIntensity?: number; speechEnergyValue?: number },
      ) => void;
      endExternalAudioSignalSource?: (sourceId: string) => void;
      hasConfiguredLipSyncParameters?: () => boolean;
    };
    LAppDelegate?: {
      getInstance?: () => {
        onResize?: () => void;
      };
      releaseInstance?: () => void;
    };
  }
}
