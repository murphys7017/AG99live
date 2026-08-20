import type {
  DirectParameterPlanInput,
  DirectParameterPlanStartOptions,
  DirectParameterPlanTerminalStatus,
} from "./direct-parameter-plan";

export type {
  DirectParameterPlanTerminalEvent,
  DirectParameterPlanTerminalStatus,
} from "./direct-parameter-plan";

export type MotionPlaybackStartResult =
  | { status: "rejected"; reason: string }
  | { status: "started"; runId: string };

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
    initializeLive2D?: () => Promise<void>;
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
        options?: {
          lipSyncEnabled?: boolean;
          onFailed?: (reason: string) => void;
          onLipSyncUnavailable?: (reason: string) => void;
        },
      ) => void;
      writeExternalAudioSignalSource?: (
        sourceId: string,
        values: {
          lipSyncIntensity?: number;
          speechEnergyValue?: number;
          speechEmphasisValue?: number;
        },
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
