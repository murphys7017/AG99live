import { LAppLive2DManager } from "./lapplive2dmanager";
import { LAppModel } from "./lappmodel";
import * as LAppDefine from './lappdefine';

import {
  CubismMotionQueueEntryHandle,
  InvalidMotionQueueEntryHandleValue
} from '@framework/motion/cubismmotionqueuemanager';
import type {
  DirectParameterPlanInput,
  DirectParameterPlanStartOptions,
  DirectParameterPlanTerminalStatus,
} from "./directparameterplan";

export interface CatalogMotionLifecycleCallbacks {
  playbackClockReader?: { getElapsedMs: () => number | null };
  onStarted?: () => void;
  onFinished?: () => void;
  onFailed?: (reason: string) => void;
  onInterrupted?: (reason: string) => void;
}

let s_adapter_instance: LAppAdapter | null | undefined = null;

export class LAppAdapter {
  private _directParameterPlanError = "";
  public static getInstance(): LAppAdapter {
    if (s_adapter_instance == null) {
      s_adapter_instance = new LAppAdapter();
    }

    return s_adapter_instance;
  }

  /* gets */

  private getMgr(): LAppLive2DManager | null {
    return LAppLive2DManager.getExistingInstance();
  }

  private getModel(): LAppModel | null {
    return this.getMgr()?.getModel(0) ?? null;
  }

  /* motion */

  public startMotion(
    group: string,
    no: number,
    priority: number,
    callbacks?: CatalogMotionLifecycleCallbacks
  ): CubismMotionQueueEntryHandle {
    return this.getModel()?.startMotion(group, no, priority, callbacks) ?? InvalidMotionQueueEntryHandleValue;
  }

  public stopMotion(reason?: string): void {
    this.getModel()?.stopMotion(reason);
  }

  public getMotionStartError(): string {
    return this.getModel()?.getMotionStartError?.() ?? "";
  }

  public applyRuntimeEffectsSettings(settings: {
    ambientMotionEnabled: boolean;
    physicsResponseScale: number;
    protectedPhysicsOutputParameterIds: readonly string[];
  }): void {
    LAppDefine.applyRuntimeEffectsSettings(settings);
    const model = this.getModel();
    if (!settings.ambientMotionEnabled) {
      model?.stopAmbientMotion();
    }
    model?.setPhysicsResponseScale(settings.physicsResponseScale);
    model?.setPhysicsResponseProtectedParameterIds(
      settings.protectedPhysicsOutputParameterIds,
    );
  }

  public startDirectParameterPlan(
    plan: DirectParameterPlanInput,
    options?: DirectParameterPlanStartOptions,
  ): boolean {
    const model = this.getModel();
    if (!model) {
      this._directParameterPlanError = "live2d_model_unavailable";
      return false;
    }
    const started = model.startDirectParameterPlan(plan, options);
    this._directParameterPlanError = started
      ? ""
      : model.getDirectParameterPlanError() || "direct_parameter_plan_rejected";
    return started;
  }

  public stopDirectParameterPlan(
    reason?: string,
    status?: DirectParameterPlanTerminalStatus,
  ): void {
    this.getModel()?.stopDirectParameterPlan(reason, status);
  }

  public getDirectParameterPlanError(): string {
    return this.getModel()?.getDirectParameterPlanError?.()
      || this._directParameterPlanError;
  }

  public beginExternalAudioSignalSource(
    sourceId: string,
    options?: {
      lipSyncEnabled?: boolean;
      onFailed?: (reason: string) => void;
      onLipSyncUnavailable?: (reason: string) => void;
    },
  ): void {
    const model = this.getModel();
    if (!model) {
      throw new Error("live2d_model_unavailable");
    }
    model.beginExternalAudioSignalSource(sourceId, options);
  }

  public writeExternalAudioSignalSource(
    sourceId: string,
    values: {
      lipSyncIntensity?: number;
      speechEnergyValue?: number;
      speechEmphasisValue?: number;
    },
  ): void {
    const model = this.getModel();
    if (!model) {
      throw new Error("live2d_model_unavailable");
    }
    model.writeExternalAudioSignalSource(sourceId, values);
  }

  public endExternalAudioSignalSource(sourceId: string): void {
    const model = this.getModel();
    if (!model) {
      throw new Error("live2d_model_unavailable");
    }
    model.endExternalAudioSignalSource(sourceId);
  }

  public hasConfiguredLipSyncParameters(): boolean {
    const model = this.getModel();
    if (!model) {
      throw new Error("live2d_model_unavailable");
    }
    return model.hasConfiguredLipSyncParameters();
  }

}
