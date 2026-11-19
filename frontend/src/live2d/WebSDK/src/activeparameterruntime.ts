import type { CubismIdHandle } from "@framework/id/cubismid";
import type { GazeTarget } from "../../../types/live2d-runtime";
import type { CubismModel } from "@framework/model/cubismmodel";
import type { csmVector } from "@framework/type/csmvector";
import {
  ActiveParameterMixer,
  resolveIdlePlanPriority,
  type ActiveIdlePlan,
  type ActiveDirectParameterFrameState,
  type ActiveInteractionGazeState,
  type ActiveInteractionSwayState,
  type ParameterFrameOwner,
} from "./parametermixer";
import {
  SpeechSignalRuntime,
  type ExternalAudioSignalSourceOptions,
  type ExternalAudioSignalValues,
} from "./speechsignalruntime";
import type { ResolvedParameterFrameEntry } from "./parametermixer";

export type { ExternalAudioSignalSourceOptions, ExternalAudioSignalValues };

// The director admits at most three concurrent sources. Keep a small release
// overlap budget so repeated model/profile changes cannot grow the runtime map
// without bound while old parameter plans fade out.
const MAX_IDLE_PLAN_INSTANCES = 6;

export interface ActiveParameterFrameFailure {
  owner: ParameterFrameOwner;
  reason: string;
}

export interface ActiveParameterFrameResult {
  failure: ActiveParameterFrameFailure | null;
  directPlanReleased: boolean;
  parameters: readonly ResolvedParameterFrameEntry[];
}

/**
 * Owns AG99's active parameter sources. Cubism lifecycle, Physics, and draw
 * remain in LAppModel; this runtime resolves multiple ambient plans and all
 * foreground sources into exactly one pre-Physics write.
 */
export class ActiveParameterRuntime {
  private readonly mixer = new ActiveParameterMixer();
  private readonly speechSignals = new SpeechSignalRuntime();
  private readonly getSpeechAudioGain = (axisId: string): number =>
    this.speechSignals.getSpeechAudioGain(axisId);
  private interactionSway: ActiveInteractionSwayState | null = null;
  private interactionGaze: ActiveInteractionGazeState | null = null;
  private readonly idlePlans = new Map<string, ActiveIdlePlan>();
  private idlePlanSequence = 0;

  public startIdlePlan(
    state: ActiveDirectParameterFrameState,
    actionId?: string,
    source?: string,
  ): boolean {
    const normalizedActionId = actionId?.trim()
      || `ambient:${++this.idlePlanSequence}`;
    const hasActiveDuplicate = [...this.idlePlans.values()].some(
      (plan) => plan.actionId === normalizedActionId
        && plan.state.releaseStartedAtMs === null,
    );
    if (hasActiveDuplicate) return false;
    if (this.idlePlans.size >= MAX_IDLE_PLAN_INSTANCES) return false;
    const instanceId = `${normalizedActionId}:${++this.idlePlanSequence}`;
    const normalizedSource = source?.trim() || "ambient";
    this.idlePlans.set(instanceId, {
      actionId: normalizedActionId,
      state,
      source: normalizedSource,
      priority: resolveIdlePlanPriority(normalizedSource),
    });
    return true;
  }

  /** Marks one or all ambient plans for parameter-level release. */
  public releaseIdlePlan(actionId?: string): void {
    const normalizedActionId = actionId?.trim() ?? "";
    const states = normalizedActionId
      ? [...this.idlePlans.values()].filter((plan) => plan.actionId === normalizedActionId)
      : [...this.idlePlans.values()];
    for (const plan of states) {
      if (plan.state.releaseStartedAtMs === null) {
        plan.state.releaseStartedAtMs = plan.state.presentationElapsedMs;
      }
    }
  }

  public reset(): void {
    this.speechSignals.reset();
    this.interactionSway = null;
    this.interactionGaze = null;
    this.idlePlans.clear();
    this.mixer.reset();
  }

  public startInteractionSway(state: ActiveInteractionSwayState): void {
    this.interactionSway = state;
  }

  public stopInteractionSway(): void {
    this.interactionSway = null;
  }

  public startInteractionGaze(state: ActiveInteractionGazeState): void {
    this.interactionGaze = state;
  }

  public updateInteractionGaze(target: GazeTarget): boolean {
    if (!this.interactionGaze || !Number.isFinite(target.horizontalRatio)
        || !Number.isFinite(target.verticalRatio)) return false;
    this.interactionGaze.target = target;
    return true;
  }

  public stopInteractionGaze(): void {
    this.interactionGaze = null;
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
    deltaTimeSeconds: number;
    lipSyncEnabled: boolean;
    lipSyncActive: boolean;
    lipSyncIntensity: number;
    lipSyncParameterIds: csmVector<CubismIdHandle>;
  }): ActiveParameterFrameResult {
    if (this.interactionSway) {
      this.interactionSway.elapsedMs = performance.now() - this.interactionSway.startedAtMs;
      const { elapsedMs, delayMs, attackMs, holdMs } = this.interactionSway;
      if (elapsedMs >= delayMs + attackMs + holdMs) {
        this.interactionSway = null;
      }
    }
    if (this.interactionGaze) {
      this.interactionGaze.elapsedMs = performance.now() - this.interactionGaze.startedAtMs;
    }
    let execution = this.mixer.resolveActiveFrame({
      ...input,
      idlePlans: [...this.idlePlans.values()],
      interactionSway: this.interactionSway,
      interactionGaze: this.interactionGaze,
      getSpeechAudioGain: this.getSpeechAudioGain,
    });
    if (execution.ok === false && execution.owner === "idle_motion") {
      console.warn("[IdleMotion] mixer source rejected.", execution.reason);
      for (const state of execution.failedIdlePlans ?? []) {
        this.removeIdlePlanState(state);
      }
      execution = this.mixer.resolveActiveFrame({
        ...input,
        deltaTimeSeconds: 0,
        idlePlans: [...this.idlePlans.values()],
        interactionSway: this.interactionSway,
        interactionGaze: this.interactionGaze,
        getSpeechAudioGain: this.getSpeechAudioGain,
      });
    }
    if (execution.ok === false) {
      return {
        failure: {
          owner: execution.owner,
          reason: execution.reason,
        },
        directPlanReleased: false,
        parameters: [],
      };
    }
    for (const state of execution.releasedIdlePlans) {
      this.removeIdlePlanState(state);
    }

    const planState = input.directPlan;
    const lipSyncDiagnosticSourceId = execution.directPlan.contributions.length === 0
      && execution.lipSyncContributionCount > 0
      ? this.speechSignals.getLipSyncDiagnosticSourceId()
      : null;
    if (execution.directPlan.shouldLogFrame && planState) {
      console.info("[LAppModel] Active parameter frame resolved.", {
        runId: (planState as ActiveDirectParameterFrameState & { runId?: string }).runId ?? null,
        mode: planState.mode,
        emotion: planState.emotionLabel,
        elapsedMs: execution.directPlan.elapsedMs,
        bindingCount: planState.semanticBindings.length,
        contributionCount: execution.directPlan.contributions.length,
        allBindingsActivated: execution.directPlan.allBindingsActivated,
        nominalReleaseReached: execution.directPlan.nominalReleaseReached,
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
      parameters: execution.parameters,
    };
  }

  private removeIdlePlanState(state: ActiveDirectParameterFrameState): void {
    for (const [instanceId, current] of this.idlePlans) {
      if (current.state === state) {
        this.idlePlans.delete(instanceId);
        return;
      }
    }
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
