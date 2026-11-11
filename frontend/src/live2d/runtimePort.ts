import type {
  DirectParameterPlanInput,
  DirectParameterPlanStartOptions,
  DirectParameterPlanTerminalStatus,
  InteractionGazeInput,
  InteractionSwayInput,
  MotionResourceLifecycleCallbacks,
} from "../types/live2d-runtime.d.ts";

export interface Live2dRuntimePort {
  applyRuntimeEffectsSettings(settings: {
    ambientMotionEnabled: boolean;
    physicsResponseScale: number;
    protectedPhysicsOutputParameterIds: string[];
  }): void;
  startDirectParameterPlan(
    plan: DirectParameterPlanInput,
    options?: DirectParameterPlanStartOptions,
  ): boolean;
  stopDirectParameterPlan(
    reason?: string,
    status?: DirectParameterPlanTerminalStatus,
  ): void;
  getDirectParameterPlanError(): string;
  startIdleParameterPlan(plan: DirectParameterPlanInput): boolean;
  stopIdleParameterPlan(): void;
  startMotion(
    group: string,
    no: number,
    priority: number,
    callbacks?: MotionResourceLifecycleCallbacks,
  ): unknown;
  stopMotion(reason?: string): void;
  getMotionStartError(): string;
  startInteractionSway(input: InteractionSwayInput): boolean;
  stopInteractionSway(): void;
  startInteractionGaze(input: InteractionGazeInput): boolean;
  updateInteractionGaze(targetRatio: number): void;
  stopInteractionGaze(): void;
  beginExternalAudioSignalSource(
    sourceId: string,
    options?: {
      lipSyncEnabled?: boolean;
      onFailed?: (reason: string) => void;
      onLipSyncUnavailable?: (reason: string) => void;
    },
  ): void;
  writeExternalAudioSignalSource(
    sourceId: string,
    values: {
      lipSyncIntensity?: number;
      speechEnergyValue?: number;
      speechEmphasisValue?: number;
    },
  ): void;
  endExternalAudioSignalSource(sourceId: string): void;
  hasConfiguredLipSyncParameters(): boolean;
}

type WindowAdapter = NonNullable<ReturnType<NonNullable<Window["getLAppAdapter"]>>>;

export function createWindowLive2dRuntimePort(): Live2dRuntimePort {
  const getAdapter = (): WindowAdapter | null => window.getLAppAdapter?.() ?? null;

  return {
    applyRuntimeEffectsSettings(settings) {
      getAdapter()?.applyRuntimeEffectsSettings(settings);
    },
    startDirectParameterPlan(plan, options) {
      return getAdapter()?.startDirectParameterPlan?.(plan, options) ?? false;
    },
    stopDirectParameterPlan(reason, status) {
      getAdapter()?.stopDirectParameterPlan?.(reason, status);
    },
    getDirectParameterPlanError() {
      return getAdapter()?.getDirectParameterPlanError?.().trim() ?? "";
    },
    startIdleParameterPlan(plan) {
      return getAdapter()?.startIdleParameterPlan?.(plan) ?? false;
    },
    stopIdleParameterPlan() {
      getAdapter()?.stopIdleParameterPlan?.();
    },
    startMotion(group, no, priority, callbacks) {
      return getAdapter()?.startMotion?.(group, no, priority, callbacks);
    },
    stopMotion(reason) {
      getAdapter()?.stopMotion?.(reason);
    },
    getMotionStartError() {
      return getAdapter()?.getMotionStartError?.().trim() ?? "";
    },
    startInteractionSway(input) {
      return getAdapter()?.startInteractionSway?.(input) ?? false;
    },
    stopInteractionSway() {
      getAdapter()?.stopInteractionSway?.();
    },
    startInteractionGaze(input) {
      return getAdapter()?.startInteractionGaze?.(input) ?? false;
    },
    updateInteractionGaze(targetRatio) {
      getAdapter()?.updateInteractionGaze?.(targetRatio);
    },
    stopInteractionGaze() {
      getAdapter()?.stopInteractionGaze?.();
    },
    beginExternalAudioSignalSource(sourceId, options) {
      getAdapter()?.beginExternalAudioSignalSource?.(sourceId, options);
    },
    writeExternalAudioSignalSource(sourceId, values) {
      getAdapter()?.writeExternalAudioSignalSource?.(sourceId, values);
    },
    endExternalAudioSignalSource(sourceId) {
      getAdapter()?.endExternalAudioSignalSource?.(sourceId);
    },
    hasConfiguredLipSyncParameters() {
      return getAdapter()?.hasConfiguredLipSyncParameters?.() === true;
    },
  };
}
