import type {
  DirectParameterPlanInput,
  DirectParameterPlanStartOptions,
  DirectParameterPlanTerminalStatus,
} from "./direct-parameter-plan";

export type {
  DirectParameterPlanInput,
  DirectParameterPlanStartOptions,
  DirectParameterPlanTerminalEvent,
  DirectParameterPlanTerminalStatus,
} from "./direct-parameter-plan";

export type MotionPlaybackStartResult =
  | { status: "rejected"; reason: string }
  | { status: "started"; runId: string };

export interface GazeTarget {
  horizontalRatio: number;
  verticalRatio: number;
}

export interface InteractionParameterBinding {
  targetComponent?: keyof GazeTarget;
  onsetDelayMs?: number;
  /** Optional semantic axis owner for mixed gaze inputs. */
  axisId?: string;
  /** Scales the target excursion around the binding's neutral value. */
  targetRatioScale?: number;
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
}

export interface InteractionSwayInput {
  axisId: string;
  delayMs: number;
  attackMs: number;
  holdMs: number;
  bindings: InteractionParameterBinding[];
}

/** Horizontal follow fractions at the model profile's first pose anchor. */
export interface GazeAlignment {
  head: number;
  body: number;
}

export interface InteractionGazeInput {
  /** Mk6 horizontal head pose as presented by Cubism physics. */
  horizontalHeadFeedback?: { parameterId: string; neutral: number; eyeUnitsPerHeadUnit: number };
  axisId: string;
  target: GazeTarget;
  bindings: InteractionSwayInput["bindings"];
}

export interface ExternalAudioSignalSourceOptions {
  lipSyncEnabled?: boolean;
  postureBindings?: InteractionParameterBinding[];
  onFailed?: (reason: string) => void;
  onLipSyncUnavailable?: (reason: string) => void;
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
      startIdleParameterPlan?: (
        plan: DirectParameterPlanInput,
        actionId?: string,
        source?: string | null,
      ) => boolean;
      releaseIdleParameterPlan?: (actionId?: string) => void;
      stopDirectParameterPlan?: (reason?: string, status?: DirectParameterPlanTerminalStatus) => void;
      releaseActiveMotion?: () => boolean;
      getDirectParameterPlanError?: () => string;
      startInteractionSway?: (input: InteractionSwayInput) => boolean;
      stopInteractionSway?: () => void;
      startInteractionGaze?: (input: InteractionGazeInput) => boolean;
      updateInteractionGaze?: (target: GazeTarget) => boolean;
      stopInteractionGaze?: () => void;
      beginExternalAudioSignalSource?: (
        sourceId: string,
        options?: ExternalAudioSignalSourceOptions,
      ) => void;
      writeExternalAudioSignalSource?: (
        sourceId: string,
        values: {
          lipSyncIntensity?: number;
          mouthRound?: number;
          mouthWide?: number;
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
