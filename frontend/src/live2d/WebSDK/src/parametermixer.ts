import type { CubismIdHandle } from "@framework/id/cubismid";
import type { GazeTarget } from "../../../types/live2d-runtime";
import type { CubismModel } from "@framework/model/cubismmodel";
import type { csmVector } from "@framework/type/csmvector";
import type { DirectParameterExecutionPlan } from "./directparameterplan";
import {
  resolveParameterPresentationFrame,
  resolveParameterPresentationTrack,
  type ParameterPresentationNode,
  type ParameterPresentationTrackPoint,
} from "./parameterpresentation";

export const PARAMETER_MIX_PRIORITY = {
  ambientLocal: 20,
  ambientMaterial: 26,
  ambientModelPassive: 32,
  idleMotion: 20,
  interactionSway: 50,
  interactionGaze: 60,
  directPlan: 100,
  lipSync: 200,
} as const;

export function resolveIdlePlanPriority(source: string): number {
  switch (source) {
    case "model_passive":
      return PARAMETER_MIX_PRIORITY.ambientModelPassive;
    case "material_composition":
      return PARAMETER_MIX_PRIORITY.ambientMaterial;
    case "local":
      return PARAMETER_MIX_PRIORITY.ambientLocal;
    default:
      return PARAMETER_MIX_PRIORITY.idleMotion;
  }
}

export type ParameterContributionOwner = "idle_motion" | "interaction_sway" | "interaction_gaze" | "direct_plan" | "pose_release" | "lip_sync";
export type ParameterFrameOwner = ParameterContributionOwner | "mixed";

export interface DirectSemanticParameterBinding {
  axisId: string;
  parameterIdRaw: string;
  activationAtMs: number;
  targetValue: number;
  neutralTargetValue: number;
  weight: number;
  keyframes: ParameterPresentationTrackPoint[];
  modulationAmplitude: number;
  modulationDirection: number;
  modulationDelayMs: number;
  modulationPoints: ParameterPresentationTrackPoint[];
  modulation: {
    kind: string;
    preset: string;
    amplitude: number | null;
    direction: number | null;
    delayMs: number | null;
    points: Array<{
      atMs: number;
      transitionMs: number;
      value: number;
    }>;
  } | null;
  maxSpeechOffset: number;
  parameterIndex: number;
  presentation: ParameterPresentationNode;
}

export interface ActiveDirectParameterFrameState {
  mode: "expressive" | "idle";
  emotionLabel: string;
  timing: DirectParameterExecutionPlan["timing"];
  semanticBindings: DirectSemanticParameterBinding[];
  playbackClockReader: { getElapsedMs: () => number | null };
  presentationElapsedMs: number;
  diagnosticFrameCount: number;
  /** Set only after every binding has activated and the active target settled. */
  releaseStartedAtMs: number | null;
}

export interface ActiveIdlePlan {
  actionId: string;
  state: ActiveDirectParameterFrameState;
  source: string;
  priority: number;
}

export interface ActiveInteractionSwayBinding {
  targetComponent?: keyof GazeTarget;
  axisId: string;
  parameterIdRaw: string;
  parameterIndex: number;
  neutralValue: number;
  negativeValue: number;
  positiveValue: number;
  weight: number;
  presentation: ParameterPresentationNode;
}

export interface ActiveInteractionSwayState {
  delayMs: number;
  attackMs: number;
  holdMs: number;
  targetRatio: number;
  elapsedMs: number;
  bindings: ActiveInteractionSwayBinding[];
}

export interface ActiveInteractionGazeState {
  target: GazeTarget;
  elapsedMs: number;
  bindings: ActiveInteractionSwayBinding[];
  timing: DirectParameterExecutionPlan["timing"];
}

export interface ParameterContribution {
  parameterIdRaw: string;
  parameterIndex: number;
  owner: ParameterContributionOwner;
  source: string;
  value: number;
  weight: number;
  priority: number;
  presentation?: {
    node: ParameterPresentationNode;
    elapsedMs: number;
    timing: DirectParameterExecutionPlan["timing"] | null;
  };
}

export type ParameterBaseSnapshot =
  | {
      parameterId: CubismIdHandle;
      parameterIdRaw: string;
      writable: true;
      baseValue: number;
      minimumValue: number;
      maximumValue: number;
    }
  | {
      writable: false;
    };

export interface ResolvedParameterContribution {
  owner: ParameterContributionOwner;
  source: string;
  value: number;
  weight: number;
  priority: number;
  resolvedValue: number;
}

export interface ResolvedParameterFrameEntry {
  parameterId: CubismIdHandle;
  parameterIdRaw: string;
  parameterIndex: number;
  owner: ParameterFrameOwner;
  baseValue: number;
  unclampedValue: number;
  value: number;
  clamped: boolean;
  contributions: ResolvedParameterContribution[];
}

export type ActiveParameterMixerResolution =
  | {
      ok: true;
      parameters: ResolvedParameterFrameEntry[];
      directPresentationSettled: boolean;
    }
  | {
      ok: false;
      reason: string;
      owner: ParameterFrameOwner;
    };

export interface DirectPlanContributionCollection {
  contributions: ParameterContribution[];
  failure: string | null;
  shouldLogFrame: boolean;
  elapsedMs: number | null;
  allBindingsActivated: boolean;
  nominalReleaseReached: boolean;
  releaseEligible: boolean;
  released: boolean;
}

const EMPTY_DIRECT_PLAN_COLLECTION: DirectPlanContributionCollection = {
  contributions: [],
  failure: null,
  shouldLogFrame: false,
  elapsedMs: null,
  allBindingsActivated: false,
  nominalReleaseReached: false,
  releaseEligible: false,
  released: false,
};

const EMPTY_PARAMETER_BASE_SNAPSHOTS: ReadonlyMap<number, ParameterBaseSnapshot> =
  new Map();

export interface ActiveParameterFrameInput {
  idlePlans?: readonly ActiveIdlePlan[];
  model: CubismModel | null;
  directPlan: ActiveDirectParameterFrameState | null;
  deltaTimeSeconds: number;
  interactionSway: ActiveInteractionSwayState | null;
  interactionGaze: ActiveInteractionGazeState | null;
  lipSyncEnabled: boolean;
  lipSyncActive: boolean;
  lipSyncIntensity: number;
  lipSyncParameterIds: csmVector<CubismIdHandle>;
  getSpeechAudioGain: (axisId: string) => number;
}

export type ActiveParameterFrameExecution =
  | {
      ok: true;
      parameters: ResolvedParameterFrameEntry[];
      directPlan: DirectPlanContributionCollection;
      idlePlans: readonly DirectPlanContributionCollection[];
      releasedIdlePlans: readonly ActiveDirectParameterFrameState[];
      lipSyncContributionCount: number;
    }
  | {
      ok: false;
      reason: string;
      owner: ParameterFrameOwner;
      failedIdlePlans?: readonly ActiveDirectParameterFrameState[];
    };

/**
 * Owns raw contribution collection, multi-source target synthesis, one response
 * pass, one frozen Cubism base snapshot, and the final pre-Physics parameter write.
 */
export class ActiveParameterMixer {
  private lastPresentations = new Map<number, {
    node: ParameterPresentationNode; elapsedMs: number; owner: ParameterContributionOwner;
  }>();

  public reset(): void { this.lastPresentations.clear(); }
  public resolveActiveFrame(
    input: ActiveParameterFrameInput,
  ): ActiveParameterFrameExecution {
    const model = input.model;
    if (!model) {
      return { ok: false, owner: "mixed", reason: "parameter_mixer_model_unavailable" };
    }

    const hasLipSyncSource = input.lipSyncEnabled
      && input.lipSyncActive
      && input.lipSyncParameterIds.getSize() > 0;
    const idleStates = input.idlePlans ?? [];
    if (
      input.directPlan === null
      && idleStates.length === 0
      && input.interactionSway === null
      && input.interactionGaze === null
      && !hasLipSyncSource
      && this.lastPresentations.size === 0
    ) {
      // Most idle frames have no active parameter source. Avoid rebuilding the
      // contribution graph and base snapshots when there is nothing to write.
      return {
        ok: true,
        parameters: [],
        directPlan: EMPTY_DIRECT_PLAN_COLLECTION,
        idlePlans: [],
        releasedIdlePlans: [],
        lipSyncContributionCount: 0,
      };
    }

    const directPlan = this.collectDirectPlanContributions(
      input.directPlan,
      input.getSpeechAudioGain,
      input.deltaTimeSeconds,
    );
    if (directPlan.failure) {
      return { ok: false, owner: "direct_plan", reason: directPlan.failure };
    }
    const claimedParameters = new Set(
      directPlan.contributions.map((contribution) => contribution.parameterIndex),
    );
    const idlePlanCollections: Array<{
      state: ActiveDirectParameterFrameState;
      collection: DirectPlanContributionCollection;
    }> = [];
    for (const idlePlan of idleStates) {
      const idleState = idlePlan.state;
      const collection = this.collectDirectPlanContributions(
        idleState, () => 0, input.deltaTimeSeconds,
      );
      if (collection.failure) {
        return {
          ok: false,
          owner: "idle_motion",
          reason: collection.failure,
          failedIdlePlans: [idleState],
        };
      }
      if (collection.elapsedMs !== null) {
        const attackElapsed = idleState.releaseStartedAtMs === null
          ? collection.elapsedMs
          : Math.min(collection.elapsedMs, idleState.releaseStartedAtMs);
        const attack = smoothstep(
          Math.min(1, attackElapsed / Math.max(1, idleState.timing.blendInMs)),
        );
        // Foreground bindings own their parameters while ambient plans continue
        // to contribute to every parameter that remains available for mixing.
        collection.contributions = collection.contributions
          .filter((c) => !claimedParameters.has(c.parameterIndex))
          .map((c) => ({
            ...c,
            owner: "idle_motion",
            source: `idle_motion:${idlePlan.source}:${c.parameterIdRaw}`,
            priority: idlePlan.priority,
            weight: c.weight * attack,
          }));
        if (idleState.releaseStartedAtMs === null && collection.nominalReleaseReached) {
          idleState.releaseStartedAtMs = collection.elapsedMs;
        }
      }
      idlePlanCollections.push({ state: idleState, collection });
    }
    const interactionSway = this.collectInteractionSwayContributions(input.interactionSway);
    const interactionGaze = this.collectInteractionGazeContributions(input.interactionGaze);
    const lipSyncContributions = this.collectLipSyncContributions(input, model);
    if (typeof lipSyncContributions === "string") {
      return { ok: false, owner: "lip_sync", reason: lipSyncContributions };
    }

    const contributions = [
      ...idlePlanCollections.flatMap(({ collection }) => collection.contributions),
      ...interactionSway.contributions,
      ...interactionGaze.contributions,
      ...directPlan.contributions,
      ...lipSyncContributions,
    ];
    // A stopped plan has already emitted its terminal. Its visible parameters
    // can still settle against the current base pose on the render clock.
    for (const contribution of contributions) claimedParameters.add(contribution.parameterIndex);
    for (const [parameterIndex, previous] of this.lastPresentations) {
      if ((previous.owner !== "interaction_gaze" && previous.owner !== "interaction_sway"
          && previous.owner !== "direct_plan" && previous.owner !== "pose_release")
        || (!previous.node.drivenOffset && !previous.node.velocity)
        || claimedParameters.has(parameterIndex)) {
        continue;
      }
      contributions.push({
        parameterIdRaw: previous.node.parameterId,
        parameterIndex,
        owner: "pose_release",
        source: "pose_release",
        value: previous.node.neutralValue,
        weight: 0,
        priority: 0,
        presentation: {
          node: previous.node,
          elapsedMs: previous.elapsedMs + Math.max(0, input.deltaTimeSeconds) * 1000,
          timing: null,
        },
      });
    }
    const resolution = this.resolveFrame(
      contributions,
      this.captureParameterBaseSnapshots(model, contributions),
    );
    if (resolution.ok === false) {
      return {
        ok: false,
        owner: resolution.owner,
        reason: resolution.reason,
        ...(resolution.owner === "idle_motion"
          ? { failedIdlePlans: idlePlanCollections.map(({ state }) => state) }
          : {}),
      };
    }

    const directPlanExecution = {
      ...directPlan,
      released: directPlan.releaseEligible && resolution.directPresentationSettled,
    };
    const releasedIdlePlans: ActiveDirectParameterFrameState[] = [];
    const idlePlanExecutions = idlePlanCollections.map(({ state, collection }) => {
      const released = collection.releaseEligible;
      if (released) {
        releasedIdlePlans.push(state);
      }
      return { ...collection, released };
    });

    if (
      input.directPlan
      && input.directPlan.releaseStartedAtMs === null
      && directPlan.elapsedMs !== null
      && directPlan.nominalReleaseReached
      && directPlan.allBindingsActivated
    ) {
      input.directPlan.releaseStartedAtMs = directPlan.elapsedMs;
    }

    for (const parameter of resolution.parameters) {
      model.setParameterValueById(parameter.parameterId, parameter.value);
      const readbackValue = model.getParameterValueByIndex(parameter.parameterIndex);
      if (Math.abs(readbackValue - parameter.value) > 0.001) {
        return {
          ok: false,
          owner: parameter.owner,
          reason: `parameter_mixer_write_mismatch:${parameter.parameterIdRaw}`,
          ...(parameter.owner === "idle_motion"
            ? { failedIdlePlans: idlePlanCollections.map(({ state }) => state) }
            : {}),
        };
      }
    }

    return {
      ok: true,
      parameters: resolution.parameters,
      directPlan: directPlanExecution,
      idlePlans: idlePlanExecutions,
      releasedIdlePlans,
      lipSyncContributionCount: lipSyncContributions.length,
    };
  }

  public resolveFrame(
    contributions: readonly ParameterContribution[],
    baseSnapshots: ReadonlyMap<number, ParameterBaseSnapshot>,
  ): ActiveParameterMixerResolution {
    if (contributions.length === 0) {
      this.reset();
      return { ok: true, parameters: [], directPresentationSettled: true };
    }

    const grouped = new Map<number, {
      parameterIdRaw: string;
      contributions: Array<ParameterContribution & { sequence: number }>;
    }>();

    for (const [sequence, contribution] of contributions.entries()) {
      const invalidReason = validateContribution(contribution);
      if (invalidReason) {
        return {
          ok: false,
          reason: invalidReason,
          owner: isParameterContributionOwner(contribution.owner)
            ? contribution.owner
            : "mixed",
        };
      }
      const existing = grouped.get(contribution.parameterIndex);
      if (existing) {
        if (existing.parameterIdRaw !== contribution.parameterIdRaw) {
          return {
            ok: false,
            reason: `parameter_mixer_parameter_identity_conflict:${existing.parameterIdRaw}:${contribution.parameterIdRaw}`,
            owner: resolveContributionOwner([
              ...existing.contributions,
              contribution,
            ]),
          };
        }
        existing.contributions.push({ ...contribution, sequence });
        continue;
      }
      grouped.set(contribution.parameterIndex, {
        parameterIdRaw: contribution.parameterIdRaw,
        contributions: [{ ...contribution, sequence }],
      });
    }

    const parameters: ResolvedParameterFrameEntry[] = [];
    const nextPresentations: typeof this.lastPresentations = new Map();
    let directPresentationSettled = true;
    const orderedGroups = [...grouped.entries()]
      .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex);
    for (const [parameterIndex, group] of orderedGroups) {
      const owner = resolveContributionOwner(group.contributions);
      const snapshot = baseSnapshots.get(parameterIndex);
      if (!snapshot) {
        return {
          ok: false,
          reason: `parameter_mixer_base_snapshot_missing:${group.parameterIdRaw}`,
          owner,
        };
      }
      if (!snapshot.writable) {
        return {
          ok: false,
          reason: `parameter_mixer_parameter_not_writable:${group.parameterIdRaw}`,
          owner,
        };
      }
      if (snapshot.parameterIdRaw !== group.parameterIdRaw) {
        return {
          ok: false,
          reason: `parameter_mixer_base_snapshot_identity_conflict:${snapshot.parameterIdRaw}:${group.parameterIdRaw}`,
          owner,
        };
      }
      const minValue = snapshot.minimumValue;
      const maxValue = snapshot.maximumValue;
      const baseValue = snapshot.baseValue;
      if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue > maxValue) {
        return {
          ok: false,
          reason: `parameter_mixer_invalid_runtime_range:${group.parameterIdRaw}`,
          owner,
        };
      }
      if (!Number.isFinite(baseValue)) {
        return {
          ok: false,
          reason: `parameter_mixer_invalid_base_value:${group.parameterIdRaw}`,
          owner,
        };
      }

      let mixedTargetValue = baseValue;
      let directOnlyTargetValue = baseValue;
      const resolvedContributions: ResolvedParameterContribution[] = [];
      const orderedContributions = group.contributions.sort((left, right) => {
        const priorityOrder = left.priority - right.priority;
        if (priorityOrder !== 0) {
          return priorityOrder;
        }
        const sourceOrder = left.source.localeCompare(right.source);
        return sourceOrder !== 0 ? sourceOrder : left.sequence - right.sequence;
      });
      for (const contribution of orderedContributions) {
        const resolvedValue = resolveContributionValue(mixedTargetValue, contribution);
        resolvedContributions.push({
          owner: contribution.owner,
          source: contribution.source,
          value: contribution.value,
          weight: contribution.weight,
          priority: contribution.priority,
          resolvedValue,
        });
        mixedTargetValue = resolvedValue;
        if (contribution.owner !== "lip_sync") {
          directOnlyTargetValue = resolveContributionValue(
            directOnlyTargetValue,
            contribution,
          );
        }
      }
      // Lip sync is intentionally immediate; active response dynamics only
      // apply after all non-lip contributions have been synthesized.
      const hasLipSyncContribution = orderedContributions.some(
        (contribution) => contribution.owner === "lip_sync",
      );
      const presentationContributions = orderedContributions
        .filter((contribution) => contribution.owner !== "lip_sync" && contribution.presentation);
      const presentationContribution = presentationContributions.length > 0
        ? presentationContributions[presentationContributions.length - 1]
        : undefined;
      let presentedValue = directOnlyTargetValue;
      if (presentationContribution?.presentation) {
        const node = presentationContribution.presentation.node;
        const previous = this.lastPresentations.get(parameterIndex);
        if (previous && previous.node !== node) {
          node.drivenOffset = previous.node.drivenOffset;
          node.velocity = previous.node.velocity;
          node.lastElapsedMs = null;
        }
        if (!hasLipSyncContribution) {
          nextPresentations.set(parameterIndex, {
            node, elapsedMs: presentationContribution.presentation.elapsedMs, owner: presentationContribution.owner,
          });
        }
        const presentation = resolveParameterPresentationFrame(
          presentationContribution.presentation.node,
          directOnlyTargetValue,
          baseValue,
          presentationContribution.presentation.elapsedMs,
          presentationContribution.presentation.timing,
        );
        presentedValue = presentation.drivenValue;
        if (presentationContribution.owner === "direct_plan") {
          directPresentationSettled &&= presentation.settled;
        }
      }
      // Keep the active response state current, but never delay lip-sync output.
      const finalValue = hasLipSyncContribution ? mixedTargetValue : presentedValue;
      const value = clamp(finalValue, minValue, maxValue);

      parameters.push({
        parameterId: snapshot.parameterId,
        parameterIdRaw: group.parameterIdRaw,
        parameterIndex,
        owner,
        baseValue,
        unclampedValue: finalValue,
        value,
        clamped: value !== finalValue,
        contributions: resolvedContributions,
      });
    }

    this.lastPresentations = nextPresentations;
    return { ok: true, parameters, directPresentationSettled };
  }

  private collectDirectPlanContributions(
    planState: ActiveDirectParameterFrameState | null,
    getSpeechAudioGain: (axisId: string) => number,
    deltaTimeSeconds: number,
  ): DirectPlanContributionCollection {
    if (!planState) {
      return {
        contributions: [],
        failure: null,
        shouldLogFrame: false,
        elapsedMs: null,
        allBindingsActivated: false,
        nominalReleaseReached: false,
        releaseEligible: false,
        released: false,
      };
    }

    const clockElapsedMs = planState.playbackClockReader.getElapsedMs();
    const hasUsableClock = clockElapsedMs !== null && Number.isFinite(clockElapsedMs);
    // Follow the audio clock while it is usable, including pauses. Only after the
    // clock becomes unavailable do we advance from render time to finish the release.
    const elapsedMs = hasUsableClock
      ? Math.max(planState.presentationElapsedMs, clockElapsedMs)
      : planState.presentationElapsedMs
        + Math.max(0, deltaTimeSeconds) * 1000;
    planState.presentationElapsedMs = elapsedMs;

    const shouldLogFrame = planState.diagnosticFrameCount < 2;
    const contributions: ParameterContribution[] = [];
    let allBindingsActivated = true;
    for (const item of planState.semanticBindings) {
      if (planState.releaseStartedAtMs !== null
        && item.activationAtMs > planState.releaseStartedAtMs) continue;
      if (elapsedMs < item.activationAtMs) {
        allBindingsActivated = false;
        continue;
      }
      const rawFrameTargetValue = resolveDirectBindingTargetValue(
        item,
        elapsedMs,
        item.targetValue,
        getSpeechAudioGain,
      );
      contributions.push({
        parameterIdRaw: item.parameterIdRaw,
        parameterIndex: item.parameterIndex,
        owner: "direct_plan",
        source: `direct_plan:${item.axisId}`,
        value: rawFrameTargetValue,
        weight: item.weight * resolveParameterOwnershipWeight(
          elapsedMs,
          planState.timing,
          planState.releaseStartedAtMs,
        ),
        priority: PARAMETER_MIX_PRIORITY.directPlan,
        presentation: {
          node: item.presentation,
          elapsedMs: planState.presentationElapsedMs,
          timing: planState.timing,
        },
      });
    }

    return {
      contributions,
      failure: null,
      shouldLogFrame,
      elapsedMs,
      allBindingsActivated,
      nominalReleaseReached: elapsedMs >= Math.max(
        0,
        planState.timing.totalMs - Math.max(0, planState.timing.blendOutMs),
      ),
      releaseEligible: planState.releaseStartedAtMs !== null
        && elapsedMs >= planState.releaseStartedAtMs + Math.max(0, planState.timing.blendOutMs),
      released: false,
    };
  }

  private collectInteractionSwayContributions(
    sway: ActiveInteractionSwayState | null,
  ): { contributions: ParameterContribution[] } {
    if (!sway || sway.elapsedMs <= sway.delayMs) {
      return { contributions: [] };
    }
    const attackWeight = sway.attackMs <= 0
      ? 1
      : smoothstep((sway.elapsedMs - sway.delayMs) / sway.attackMs);
    return {
      contributions: sway.bindings.map((binding): ParameterContribution => ({
        parameterIdRaw: binding.parameterIdRaw,
        parameterIndex: binding.parameterIndex,
        owner: "interaction_sway",
        source: `interaction_sway:${binding.axisId}`,
        value: sway.targetRatio >= 0
          ? interpolate(binding.neutralValue, binding.positiveValue, sway.targetRatio)
          : interpolate(binding.neutralValue, binding.negativeValue, -sway.targetRatio),
        weight: binding.weight * attackWeight,
        priority: PARAMETER_MIX_PRIORITY.interactionSway,
        presentation: {
          node: binding.presentation,
          elapsedMs: sway.elapsedMs,
          timing: null,
        },
      })),
    };
  }

  private collectInteractionGazeContributions(
    gaze: ActiveInteractionGazeState | null,
  ): { contributions: ParameterContribution[] } {
    if (!gaze) {
      return { contributions: [] };
    }
    return {
      contributions: gaze.bindings.map((binding) => {
        const ratio = Math.max(-1, Math.min(1, gaze.target[binding.targetComponent ?? "horizontalRatio"]));
        return {
          parameterIdRaw: binding.parameterIdRaw,
          parameterIndex: binding.parameterIndex,
          owner: "interaction_gaze" as const,
          source: `interaction_gaze:${binding.axisId}`,
          value: ratio >= 0
            ? interpolate(binding.neutralValue, binding.positiveValue, ratio)
            : interpolate(binding.neutralValue, binding.negativeValue, -ratio),
          weight: binding.weight,
          priority: PARAMETER_MIX_PRIORITY.interactionGaze,
          presentation: {
            node: binding.presentation,
            elapsedMs: gaze.elapsedMs,
            timing: gaze.timing,
          },
        };
      }),
    };
  }

  private collectLipSyncContributions(
    input: ActiveParameterFrameInput,
    model: CubismModel,
  ): ParameterContribution[] | string {
    if (
      !Number.isFinite(input.lipSyncIntensity)
      || input.lipSyncIntensity < 0
      || input.lipSyncIntensity > 1
    ) {
      return "parameter_mixer_lip_sync_intensity_invalid";
    }
    if (!input.lipSyncEnabled || !input.lipSyncActive) {
      return [];
    }

    const contributions: ParameterContribution[] = [];
    for (let index = 0; index < input.lipSyncParameterIds.getSize(); index += 1) {
      const parameterId = input.lipSyncParameterIds.at(index);
      const parameterIndex = model.getParameterIndex(parameterId);
      if (!isParameterIndexWritable(model, parameterIndex)) {
        return `parameter_mixer_lip_sync_parameter_not_writable:${index}`;
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
        return `parameter_mixer_lip_sync_invalid_runtime_range:${parameterId.getString().s}`;
      }
      contributions.push({
        parameterIdRaw: parameterId.getString().s,
        parameterIndex,
        owner: "lip_sync",
        source: "lip_sync",
        value: defaultValue + (maxValue - defaultValue) * input.lipSyncIntensity,
        weight: 1,
        priority: PARAMETER_MIX_PRIORITY.lipSync,
      });
    }
    return contributions;
  }

  private captureParameterBaseSnapshots(
    model: CubismModel,
    contributions: readonly ParameterContribution[],
  ): ReadonlyMap<number, ParameterBaseSnapshot> {
    if (contributions.length === 0) {
      return EMPTY_PARAMETER_BASE_SNAPSHOTS;
    }

    const snapshots = new Map<number, ParameterBaseSnapshot>();
    for (const { parameterIndex } of contributions) {
      if (snapshots.has(parameterIndex)) {
        continue;
      }
      if (!isParameterIndexWritable(model, parameterIndex)) {
        snapshots.set(parameterIndex, { writable: false });
        continue;
      }
      const parameterId = model.getParameterId(parameterIndex);
      snapshots.set(parameterIndex, {
        parameterId,
        parameterIdRaw: parameterId.getString().s,
        writable: true,
        baseValue: model.getParameterValueByIndex(parameterIndex),
        minimumValue: model.getParameterMinimumValue(parameterIndex),
        maximumValue: model.getParameterMaximumValue(parameterIndex),
      });
    }
    return snapshots;
  }
}

function resolveDirectBindingTargetValue(
  item: DirectSemanticParameterBinding,
  elapsedMs: number,
  fallbackTargetValue: number,
  getSpeechAudioGain: (axisId: string) => number,
): number {
  const sequenceTargetValue = resolveParameterPresentationTrack(
    item.keyframes,
    elapsedMs,
    fallbackTargetValue,
  );
  if (item.modulationAmplitude <= 0) {
    return sequenceTargetValue;
  }

  const gestureValue = resolveParameterPresentationTrack(
    item.modulationPoints,
    Math.max(0, elapsedMs - item.modulationDelayMs),
    0,
  );
  return sequenceTargetValue
    + gestureValue
      * item.modulationAmplitude
      * item.modulationDirection
      * getSpeechAudioGain(item.axisId);
}

function isParameterIndexWritable(model: CubismModel, parameterIndex: number): boolean {
  return parameterIndex >= 0 && parameterIndex < model.getParameterCount();
}

function resolveContributionOwner(
  contributions: readonly Pick<ParameterContribution, "owner">[],
): ParameterFrameOwner {
  let owner: ParameterContributionOwner | null = null;
  for (const contribution of contributions) {
    if (!isParameterContributionOwner(contribution.owner)) {
      continue;
    }
    if (owner !== null && owner !== contribution.owner) {
      return "mixed";
    }
    owner = contribution.owner;
  }
  return owner ?? "mixed";
}

function validateContribution(
  contribution: ParameterContribution,
): string | null {
  if (typeof contribution.parameterIdRaw !== "string" || !contribution.parameterIdRaw.trim()) {
    return `parameter_mixer_parameter_id_missing:${contribution.parameterIndex}`;
  }
  if (!Number.isInteger(contribution.parameterIndex) || contribution.parameterIndex < 0) {
    return `parameter_mixer_invalid_parameter_index:${contribution.parameterIdRaw}`;
  }
  if (!isParameterContributionOwner(contribution.owner)) {
    return `parameter_mixer_owner_invalid:${contribution.parameterIdRaw}`;
  }
  if (typeof contribution.source !== "string" || !contribution.source.trim()) {
    return `parameter_mixer_source_missing:${contribution.parameterIdRaw}`;
  }
  if (!Number.isFinite(contribution.value) || !Number.isFinite(contribution.weight)) {
    return `parameter_mixer_non_finite_contribution:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  if (!Number.isFinite(contribution.priority)) {
    return `parameter_mixer_invalid_priority:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  if (contribution.weight < 0 || contribution.weight > 1) {
    return `parameter_mixer_invalid_weight:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  return null;
}

function isParameterContributionOwner(
  owner: unknown,
): owner is ParameterContributionOwner {
  return owner === "idle_motion"
    || owner === "pose_release"
    || owner === "interaction_sway"
    || owner === "interaction_gaze"
    || owner === "direct_plan"
    || owner === "lip_sync";
}

function resolveContributionValue(
  currentValue: number,
  contribution: ParameterContribution,
): number {
  return currentValue * (1 - contribution.weight)
    + contribution.value * contribution.weight;
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * Math.max(0, Math.min(1, progress));
}

function resolveParameterOwnershipWeight(
  elapsedMs: number,
  timing: DirectParameterExecutionPlan["timing"],
  releaseStartedAtMs: number | null,
): number {
  const blendOutMs = Math.max(0, timing.blendOutMs);
  if (releaseStartedAtMs === null || elapsedMs < releaseStartedAtMs) {
    return 1;
  }
  if (
    blendOutMs === 0
    || elapsedMs >= releaseStartedAtMs + blendOutMs
  ) {
    return 0;
  }
  return smoothstep(1 - (elapsedMs - releaseStartedAtMs) / blendOutMs);
}

function smoothstep(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}
