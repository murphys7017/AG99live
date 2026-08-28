import type { CubismIdHandle } from "@framework/id/cubismid";
import type { CubismModel } from "@framework/model/cubismmodel";
import type { csmVector } from "@framework/type/csmvector";
import {
  ActiveParameterMixer,
  type ActiveDirectParameterFrameState,
  type ParameterFrameOwner,
} from "./parametermixer";
import {
  SpeechSignalRuntime,
  type ExternalAudioSignalSourceOptions,
  type ExternalAudioSignalValues,
} from "./speechsignalruntime";

export type { ExternalAudioSignalSourceOptions, ExternalAudioSignalValues };

export interface ActiveParameterFrameFailure {
  owner: ParameterFrameOwner;
  reason: string;
}

export interface ActiveParameterFrameResult {
  failure: ActiveParameterFrameFailure | null;
  directPlanReleased: boolean;
}

/**
 * Owns AG99's active parameter sources. Cubism lifecycle, Physics, and draw
 * remain in LAppModel; this runtime resolves exactly one pre-Physics write.
 */
export class ActiveParameterRuntime {
  private readonly mixer = new ActiveParameterMixer();
  private readonly speechSignals = new SpeechSignalRuntime();

  public reset(): void {
    this.speechSignals.reset();
  }

  public beginExternalAudioSignalSource(
    sourceId: string,
    options?: ExternalAudioSignalSourceOptions,
  ): void {
    this.speechSignals.beginSource(sourceId, options);
  }

  public writeExternalAudioSignalSource(
    sourceId: string,
    values: ExternalAudioSignalValues,
  ): void {
    this.speechSignals.writeSource(sourceId, values);
  }

  public endExternalAudioSignalSource(sourceId: string): void {
    this.speechSignals.endSource(sourceId);
  }

  public advanceSpeechFrame(
    deltaTimeSeconds: number,
    includeLipSync: boolean,
  ) {
    return this.speechSignals.advanceFrame(deltaTimeSeconds, includeLipSync);
  }

  public applyFrame(input: {
    model: CubismModel | null;
    directPlan: ActiveDirectParameterFrameState | null;
    lipSyncEnabled: boolean;
    lipSyncActive: boolean;
    lipSyncIntensity: number;
    lipSyncParameterIds: csmVector<CubismIdHandle>;
  }): ActiveParameterFrameResult {
    const execution = this.mixer.resolveActiveFrame({
      ...input,
      getSpeechAudioGain: (axisId) => this.speechSignals.getSpeechAudioGain(axisId),
    });
    if (execution.ok === false) {
      return {
        failure: {
          owner: execution.owner,
          reason: execution.reason,
        },
        directPlanReleased: false,
      };
    }

    const planState = input.directPlan;
    const lipSyncDiagnosticSourceId = execution.directPlan.contributions.length === 0
      && execution.lipSyncContributionCount > 0
      ? this.speechSignals.getLipSyncDiagnosticSourceId()
      : null;
    if (execution.directPlan.shouldLogFrame && planState) {
      console.info("[LAppModel] Active parameter frame resolved.", {
        mode: planState.mode,
        emotion: planState.emotionLabel,
        parameters: execution.parameters.map((parameter) => ({
          parameterId: parameter.parameterIdRaw,
          baseValue: parameter.baseValue,
          unclampedValue: parameter.unclampedValue,
          value: parameter.value,
          clamped: parameter.clamped,
          contributions: parameter.contributions,
        })),
      });
      planState.diagnosticFrameCount += 1;
    } else if (lipSyncDiagnosticSourceId) {
      console.info("[LAppModel] Active parameter frame resolved.", {
        mode: "lip_sync",
        audioSourceId: lipSyncDiagnosticSourceId,
        parameters: execution.parameters.map((parameter) => ({
          parameterId: parameter.parameterIdRaw,
          baseValue: parameter.baseValue,
          unclampedValue: parameter.unclampedValue,
          value: parameter.value,
          clamped: parameter.clamped,
          contributions: parameter.contributions,
        })),
      });
      this.speechSignals.markLipSyncDiagnosticFrameLogged(lipSyncDiagnosticSourceId);
    }
    return {
      failure: null,
      directPlanReleased: execution.directPlan.released && planState !== null,
    };
  }

  public disableLipSync(reason: string): void {
    this.speechSignals.disableLipSync(reason);
  }

  public failActiveSource(reason: string): void {
    this.speechSignals.failActiveSource(reason);
  }

  public hasConfiguredLipSyncParameters(
    model: CubismModel | null,
    lipSyncParameterIds: csmVector<CubismIdHandle>,
  ): boolean {
    if (!model || lipSyncParameterIds.getSize() === 0) {
      return false;
    }
    for (let index = 0; index < lipSyncParameterIds.getSize(); index += 1) {
      const parameterIndex = model.getParameterIndex(lipSyncParameterIds.at(index));
      if (!isWritableParameterIndex(model, parameterIndex)) {
        return false;
      }
      const minValue = model.getParameterMinimumValue(parameterIndex);
      const defaultValue = model.getParameterDefaultValue(parameterIndex);
      const maxValue = model.getParameterMaximumValue(parameterIndex);
      if (
        !Number.isFinite(minValue)
        || !Number.isFinite(defaultValue)
        || !Number.isFinite(maxValue)
        || minValue > defaultValue
        || defaultValue >= maxValue
      ) {
        return false;
      }
    }
    return true;
  }
}

function isWritableParameterIndex(model: CubismModel, parameterIndex: number): boolean {
  return parameterIndex >= 0 && parameterIndex < model.getParameterCount();
}
