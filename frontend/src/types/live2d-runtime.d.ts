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
        onFinishedMotionHandler?: () => void,
      ) => unknown;
      stopMotion?: () => void;
      getMotionStartError?: () => string;
      setAmbientMotionEnabled?: (enabled: boolean) => void;
      startDirectParameterPlan?: (
        plan: MotionPlanPayload,
        options?: {
          runId?: string;
          onTerminal?: (event: DirectParameterPlanTerminalEvent) => void;
        },
      ) => boolean;
      stopDirectParameterPlan?: (reason?: string, status?: DirectParameterPlanTerminalStatus) => void;
      getDirectParameterPlanError?: () => string;
      loadWavFileForLipSync?: (url: string, offsetSeconds?: number) => Promise<boolean>;
      setExternalLipSyncValue?: (value: number) => void;
      clearExternalLipSyncValue?: () => void;
    };
    LAppDelegate?: {
      getInstance?: () => {
        onResize?: () => void;
      };
      releaseInstance?: () => void;
    };
  }
}
