import type { CubismIdHandle } from "@framework/id/cubismid";

export const PARAMETER_MIX_PRIORITY = {
  directPlan: 100,
  lipSync: 200,
} as const;

export type ParameterContributionOperation = "replace" | "add" | "multiply";

export interface ParameterContribution {
  parameterId: CubismIdHandle;
  parameterIdRaw: string;
  parameterIndex: number;
  source: string;
  operation: ParameterContributionOperation;
  value: number;
  weight: number;
  priority: number;
}

export interface ParameterMixerAccess {
  isParameterIndexWritable: (parameterIndex: number) => boolean;
  getParameterValue: (parameterIndex: number) => number;
  getParameterMinimumValue: (parameterIndex: number) => number;
  getParameterMaximumValue: (parameterIndex: number) => number;
}

export interface ResolvedParameterContribution {
  source: string;
  operation: ParameterContributionOperation;
  value: number;
  weight: number;
  priority: number;
  resolvedValue: number;
  clamped: boolean;
}

export interface ResolvedParameterFrameEntry {
  parameterId: CubismIdHandle;
  parameterIdRaw: string;
  parameterIndex: number;
  baseValue: number;
  value: number;
  contributions: ResolvedParameterContribution[];
}

export type ParameterMixerResolution =
  | {
      ok: true;
      parameters: ResolvedParameterFrameEntry[];
    }
  | {
      ok: false;
      reason: string;
    };

const EXTERNAL_SIGNAL_EXPIRY_MS = 180;
const SPEECH_HEAD_ENVELOPE_ATTACK_PER_SECOND = 8.0;
const SPEECH_HEAD_ENVELOPE_RELEASE_PER_SECOND = 3.0;
const SPEECH_BODY_ENVELOPE_ATTACK_PER_SECOND = 4.0;
const SPEECH_BODY_ENVELOPE_RELEASE_PER_SECOND = 1.8;
const SPEECH_AUDIO_GAIN_FLOOR = 0.32;
const SPEECH_AUDIO_GAIN_SPAN = 1.18;
const SPEECH_AUDIO_GAIN_MAX = 1.5;
const SPEECH_AUDIO_PITCH_GAIN_MAX = 1.15;
const SPEECH_BODY_GAIN_FLOOR = 0.22;
const SPEECH_BODY_GAIN_SPAN = 0.78;
const SPEECH_BODY_GAIN_MAX = 1.0;

/**
 * Owns active parameter composition and the transient audio signals consumed by
 * active parameter sources. It never interprets semantic levels or writes Cubism.
 */
export class ParameterMixer {
  private externalLipSyncValue: number | null = null;
  private externalLipSyncUpdatedAtMs = 0;
  private externalSpeechEnergyValue: number | null = null;
  private externalSpeechEnergyUpdatedAtMs = 0;
  private speechHeadEnvelope = 0;
  private speechBodyEnvelope = 0;

  public setExternalLipSyncValue(value: number): void {
    this.externalLipSyncValue = validateNormalizedSignal(
      value,
      "parameter_mixer_invalid_external_lip_sync_value",
    );
    this.externalLipSyncUpdatedAtMs = performance.now();
  }

  public clearExternalLipSyncValue(): void {
    this.externalLipSyncValue = null;
    this.externalLipSyncUpdatedAtMs = 0;
  }

  public setExternalSpeechEnergyValue(value: number): void {
    this.externalSpeechEnergyValue = validateNormalizedSignal(
      value,
      "parameter_mixer_invalid_external_speech_energy_value",
    );
    this.externalSpeechEnergyUpdatedAtMs = performance.now();
  }

  public clearExternalSpeechEnergyValue(): void {
    this.externalSpeechEnergyValue = null;
    this.externalSpeechEnergyUpdatedAtMs = 0;
  }

  public reset(): void {
    this.clearExternalLipSyncValue();
    this.clearExternalSpeechEnergyValue();
    this.speechHeadEnvelope = 0;
    this.speechBodyEnvelope = 0;
  }

  public advanceAudioFrame(
    deltaTimeSeconds: number,
    includeLipSync: boolean,
  ): number {
    const now = performance.now();
    const speechEnergy = this.resolveExternalSpeechEnergy(now) ?? 0;
    this.speechHeadEnvelope = advanceEnvelope(
      this.speechHeadEnvelope,
      speechEnergy,
      deltaTimeSeconds,
      SPEECH_HEAD_ENVELOPE_ATTACK_PER_SECOND,
      SPEECH_HEAD_ENVELOPE_RELEASE_PER_SECOND,
    );
    this.speechBodyEnvelope = advanceEnvelope(
      this.speechBodyEnvelope,
      speechEnergy,
      deltaTimeSeconds,
      SPEECH_BODY_ENVELOPE_ATTACK_PER_SECOND,
      SPEECH_BODY_ENVELOPE_RELEASE_PER_SECOND,
    );
    if (this.speechHeadEnvelope < 0.001) {
      this.speechHeadEnvelope = 0;
    }
    if (this.speechBodyEnvelope < 0.001) {
      this.speechBodyEnvelope = 0;
    }

    return includeLipSync ? this.resolveExternalLipSync(now) ?? 0 : 0;
  }

  public getSpeechAudioGain(axisId: string): number {
    const channelName = axisId.startsWith("voice_following.")
      ? axisId.slice("voice_following.".length).split("|")[0]
      : axisId;
    const rawGain = channelName.startsWith("body_")
      ? Math.min(
          SPEECH_BODY_GAIN_MAX,
          SPEECH_BODY_GAIN_FLOOR + this.speechBodyEnvelope * SPEECH_BODY_GAIN_SPAN,
        )
      : Math.min(
          SPEECH_AUDIO_GAIN_MAX,
          SPEECH_AUDIO_GAIN_FLOOR + this.speechHeadEnvelope * SPEECH_AUDIO_GAIN_SPAN,
        );
    return channelName.includes("pitch")
      ? Math.min(SPEECH_AUDIO_PITCH_GAIN_MAX, rawGain)
      : rawGain;
  }

  public resolveFrame(
    contributions: readonly ParameterContribution[],
    access: ParameterMixerAccess,
  ): ParameterMixerResolution {
    const grouped = new Map<number, {
      parameterId: CubismIdHandle;
      parameterIdRaw: string;
      contributions: Array<ParameterContribution & { sequence: number }>;
    }>();

    for (const [sequence, contribution] of contributions.entries()) {
      const invalidReason = validateContribution(contribution, access);
      if (invalidReason) {
        return { ok: false, reason: invalidReason };
      }
      const existing = grouped.get(contribution.parameterIndex);
      if (existing) {
        if (existing.parameterIdRaw !== contribution.parameterIdRaw) {
          return {
            ok: false,
            reason: `parameter_mixer_parameter_identity_conflict:${existing.parameterIdRaw}:${contribution.parameterIdRaw}`,
          };
        }
        existing.contributions.push({ ...contribution, sequence });
        continue;
      }
      grouped.set(contribution.parameterIndex, {
        parameterId: contribution.parameterId,
        parameterIdRaw: contribution.parameterIdRaw,
        contributions: [{ ...contribution, sequence }],
      });
    }

    const parameters: ResolvedParameterFrameEntry[] = [];
    for (const [parameterIndex, group] of grouped) {
      const minValue = access.getParameterMinimumValue(parameterIndex);
      const maxValue = access.getParameterMaximumValue(parameterIndex);
      const baseValue = access.getParameterValue(parameterIndex);
      if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || minValue > maxValue) {
        return {
          ok: false,
          reason: `parameter_mixer_invalid_runtime_range:${group.parameterIdRaw}`,
        };
      }
      if (!Number.isFinite(baseValue)) {
        return {
          ok: false,
          reason: `parameter_mixer_invalid_base_value:${group.parameterIdRaw}`,
        };
      }

      let value = clamp(baseValue, minValue, maxValue);
      const resolvedContributions: ResolvedParameterContribution[] = [];
      group.contributions
        .sort((left, right) => left.priority - right.priority || left.sequence - right.sequence)
        .forEach((contribution) => {
          const rawValue = resolveContributionValue(value, contribution);
          const resolvedValue = clamp(rawValue, minValue, maxValue);
          resolvedContributions.push({
            source: contribution.source,
            operation: contribution.operation,
            value: contribution.value,
            weight: contribution.weight,
            priority: contribution.priority,
            resolvedValue,
            clamped: resolvedValue !== rawValue,
          });
          value = resolvedValue;
        });

      parameters.push({
        parameterId: group.parameterId,
        parameterIdRaw: group.parameterIdRaw,
        parameterIndex,
        baseValue,
        value,
        contributions: resolvedContributions,
      });
    }

    return { ok: true, parameters };
  }

  private resolveExternalLipSync(now: number): number | null {
    if (this.externalLipSyncValue === null) {
      return null;
    }
    if (now - this.externalLipSyncUpdatedAtMs > EXTERNAL_SIGNAL_EXPIRY_MS) {
      this.clearExternalLipSyncValue();
      return null;
    }
    return this.externalLipSyncValue;
  }

  private resolveExternalSpeechEnergy(now: number): number | null {
    if (this.externalSpeechEnergyValue === null) {
      return null;
    }
    if (now - this.externalSpeechEnergyUpdatedAtMs > EXTERNAL_SIGNAL_EXPIRY_MS) {
      this.clearExternalSpeechEnergyValue();
      return null;
    }
    return this.externalSpeechEnergyValue;
  }
}

function validateContribution(
  contribution: ParameterContribution,
  access: ParameterMixerAccess,
): string | null {
  if (!contribution.parameterIdRaw || !access.isParameterIndexWritable(contribution.parameterIndex)) {
    return `parameter_mixer_parameter_not_writable:${contribution.parameterIdRaw || contribution.parameterIndex}`;
  }
  if (!Number.isFinite(contribution.value) || !Number.isFinite(contribution.weight)) {
    return `parameter_mixer_non_finite_contribution:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  if (!Number.isFinite(contribution.priority)) {
    return `parameter_mixer_invalid_priority:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  if (contribution.operation === "replace" && (contribution.weight < 0 || contribution.weight > 1)) {
    return `parameter_mixer_invalid_replace_weight:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  if (contribution.operation !== "replace" && contribution.weight < 0) {
    return `parameter_mixer_invalid_weight:${contribution.parameterIdRaw}:${contribution.source}`;
  }
  return null;
}

function resolveContributionValue(
  currentValue: number,
  contribution: ParameterContribution,
): number {
  if (contribution.operation === "replace") {
    return currentValue * (1 - contribution.weight) + contribution.value * contribution.weight;
  }
  if (contribution.operation === "add") {
    return currentValue + contribution.value * contribution.weight;
  }
  return currentValue * (1 + (contribution.value - 1) * contribution.weight);
}

function validateNormalizedSignal(value: number, reason: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(reason);
  }
  return clamp(value, 0, 1);
}

function advanceEnvelope(
  current: number,
  target: number,
  deltaTimeSeconds: number,
  attackPerSecond: number,
  releasePerSecond: number,
): number {
  const rate = target > current ? attackPerSecond : releasePerSecond;
  const blend = 1 - Math.exp(-Math.max(0, deltaTimeSeconds) * rate);
  return current + (target - current) * blend;
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}
