import type { DirectParameterPlan } from "./protocol";

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
      startMotion?: (group: string, no: number, priority: number) => number;
      setAmbientMotionEnabled?: (enabled: boolean) => void;
      startDirectParameterPlan?: (plan: DirectParameterPlan) => boolean;
      stopDirectParameterPlan?: () => void;
      getDirectParameterPlanError?: () => string;
      loadWavFileForLipSync?: (url: string) => Promise<boolean>;
    };
    LAppDelegate?: {
      getInstance?: () => {
        onResize?: () => void;
      };
      releaseInstance?: () => void;
    };
  }
}
