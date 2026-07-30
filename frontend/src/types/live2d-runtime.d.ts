import type { MotionPlanPayload } from "./protocol";

/** 参数计划的终态类型。 */
export type DirectParameterPlanTerminalStatus =
  | "completed"
  | "stopped"
  | "failed"
  | "rejected";

/** SDK 参数计划完成事件。 */
export interface DirectParameterPlanTerminalEvent {
  runId: string;
  status: DirectParameterPlanTerminalStatus;
  reason?: string;
}

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
      getModel?: (index?: number) => unknown;
      setModelPosition?: (x: number, y: number) => void;
      getMotionGroups?: () => string[];
      getMotionCount?: (group: string) => number;
      startMotion?: (
        group: string,
        no: number,
        priority: number,
        callbacks?: CatalogMotionLifecycleCallbacks,
      ) => unknown;
      stopMotion?: (reason?: string) => void;
      getMotionStartError?: () => string;
      setExpression?: (name: string) => boolean;
      stopExpression?: () => void;
      getExpressionStartError?: () => string;
      applyRuntimeEffectsSettings: (settings: {
        ambientMotionEnabled: boolean;
        physicsResponseScale: number;
        protectedPhysicsOutputParameterIds: string[];
      }) => void;
      startDirectParameterPlan?: (
        plan: MotionPlanPayload,
        options?: {
          runId?: string;
          playbackClockReader?: { getElapsedMs: () => number | null };
          onTerminal?: (event: DirectParameterPlanTerminalEvent) => void;
        },
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
