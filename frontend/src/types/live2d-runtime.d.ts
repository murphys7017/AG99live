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

export interface InteractionSwayInput {
  axisId: string;
  cycleMs: number;
  attackMs: number;
  releaseMs: number;
  bindings: Array<{
    parameterId: string;
    neutralValue: number;
    negativeValue: number;
    positiveValue: number;
    weight: number;
    maxVelocity: number;
    maxAcceleration: number;
    response: { kind: "bounded" } | {
      kind: "spring";
      frequency_hz: number;
      damping_ratio: number;
    };
  }>;
}

export interface InteractionGazeInput {
  axisId: string;
  targetRatio: number;
  bindings: InteractionSwayInput["bindings"];
}

export interface MotionResourceLifecycleCallbacks {
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
        callbacks?: MotionResourceLifecycleCallbacks,
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
      startInteractionSway?: (input: InteractionSwayInput) => boolean;
      stopInteractionSway?: () => void;
      startInteractionGaze?: (input: InteractionGazeInput) => boolean;
      updateInteractionGaze?: (targetRatio: number) => void;
      stopInteractionGaze?: () => void;
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
