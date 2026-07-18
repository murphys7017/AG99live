// @ts-nocheck
import { LAppLive2DManager } from "./lapplive2dmanager";
import { LAppModel } from "./lappmodel";
import * as LAppDefine from './lappdefine';

import {
  ACubismMotion,
  FinishedMotionCallback
} from '@framework/motion/acubismmotion';
import {
  CubismMotionQueueEntryHandle,
  InvalidMotionQueueEntryHandleValue
} from '@framework/motion/cubismmotionqueuemanager';
import { CubismFramework } from '@framework/live2dcubismframework';
import type { SemanticParameterPlan } from "../../../types/protocol";

export interface CatalogMotionLifecycleCallbacks {
  onStarted?: () => void;
  onFinished?: () => void;
  onFailed?: (reason: string) => void;
  onInterrupted?: (reason: string) => void;
}

export let s_adapter_instance : LAppAdapter | null | undefined = null;

export class LAppAdapter {
  private _directParameterPlanError = "";
  public static getInstance(): LAppAdapter {
    if (s_adapter_instance == null) {
      s_adapter_instance = new LAppAdapter();
    }

    return s_adapter_instance;
  }

  /* gets */

  public getMgr(): LAppLive2DManager {
    return LAppLive2DManager.getInstance();
  }

  public getModel(): LAppModel | null {
    return this.getMgr().getModel(0);
  }

  public getIdManager() {
    return CubismFramework.getIdManager();
  }

  /* motion */

  public getMotionGroups(): string[] {
    let groups : string[] = [];
    for (let i = 0; i < this.getModel()?._modelSetting.getMotionGroupCount(); i++) {
      groups.push(this.getModel()?._modelSetting.getMotionGroupName(i) ?? "");
    }
    return groups;
  }

  public getMotionCount(group: string): number {
    return this.getModel()?._modelSetting.getMotionCount(group) ?? 0;
  }

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

  public setAmbientMotionEnabled(enabled: boolean): void {
    LAppDefine.setAmbientMotionEnabled(enabled);
    this.getModel()?.setAmbientMotionEnabled(enabled);
  }

  public startDirectParameterPlan(plan: SemanticParameterPlan, options?: unknown): boolean {
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

  public stopDirectParameterPlan(reason?: string, status?: string): void {
    this.getModel()?.stopDirectParameterPlan(reason, status);
  }

  public getDirectParameterPlanError(): string {
    return this.getModel()?.getDirectParameterPlanError?.()
      || this._directParameterPlanError;
  }

  public setExternalLipSyncValue(value: number): void {
    const model = this.getModel();
    if (!model) {
      throw new Error("live2d_model_unavailable");
    }
    model.setExternalLipSyncValue(value);
  }

  public hasConfiguredLipSyncParameters(): boolean {
    const model = this.getModel();
    if (!model) {
      throw new Error("live2d_model_unavailable");
    }
    return model.hasConfiguredLipSyncParameters();
  }

  public clearExternalLipSyncValue(): void {
    this.getModel()?.clearExternalLipSyncValue();
  }

  public setExternalSpeechEnergyValue(value: number): void {
    const model = this.getModel();
    if (!model) {
      throw new Error("live2d_model_unavailable");
    }
    model.setExternalSpeechEnergyValue(value);
  }

  public clearExternalSpeechEnergyValue(): void {
    this.getModel()?.clearExternalSpeechEnergyValue();
  }

  /* expression */

  public getExpressionCount(): number {
    return this.getModel()?._expressions.getSize() ?? 0;
  }

  public getExpressionName(index: number): string {
    return this.getModel()?._modelSetting?.getExpressionName(index) ?? '';
  }

  public setExpression(name: string): boolean {
    return this.getModel()?.setExpression(name) ?? false;
  }

  public stopExpression(): void {
    this.getModel()?.stopExpression();
  }

  public getExpressionStartError(): string {
    return this.getModel()?.getExpressionStartError() ?? "expression_model_unavailable";
  }

  /* model position manipulation */
  
  public getModelPosition(): { x: number, y: number } {
    const model = this.getModel();
    if (model && model._modelMatrix) {
      const matrix = model._modelMatrix.getArray();
      return {
        x: matrix[12],
        y: matrix[13]
      };
    }
    return { x: 0, y: 0 };
  }
  
  public setModelPosition(x: number, y: number): void {
    const model = this.getModel();
    if (model && model._modelMatrix) {
      const matrix = model._modelMatrix.getArray();
      
      // Update the translation components
      const newMatrix = [...matrix];
      newMatrix[12] = x;
      newMatrix[13] = y;
      
      // Set the matrix
      model._modelMatrix.setMatrix(newMatrix);
    }
  }

  // private _live2DMgr: LAppLive2DManager;
}
