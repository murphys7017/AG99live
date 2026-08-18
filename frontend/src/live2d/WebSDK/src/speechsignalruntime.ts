export interface ExternalAudioSignalValues {
  lipSyncIntensity?: number;
  speechEnergyValue?: number;
}

export interface ExternalAudioSignalSourceOptions {
  onFailed?: (reason: string) => void;
}

export interface SpeechAudioFrame {
  lipSyncActive: boolean;
  lipSyncIntensity: number;
}

const SPEECH_HEAD_ENVELOPE_ATTACK_PER_SECOND = 8.0;
const SPEECH_HEAD_ENVELOPE_RELEASE_PER_SECOND = 3.0;
const SPEECH_BODY_ENVELOPE_ATTACK_PER_SECOND = 4.0;
const SPEECH_BODY_ENVELOPE_RELEASE_PER_SECOND = 1.8;
const SPEECH_HEAD_ACTIVITY_FLOOR = 0.32;
const SPEECH_AUDIO_GAIN_SPAN = 1.18;
const SPEECH_AUDIO_GAIN_MAX = 1.5;
const SPEECH_AUDIO_PITCH_GAIN_MAX = 1.15;
const SPEECH_BODY_ACTIVITY_FLOOR = 0.22;
const SPEECH_BODY_GAIN_SPAN = 0.78;
const SPEECH_BODY_GAIN_MAX = 1.0;
const SPEECH_VOICED_ENTER_THRESHOLD = 0.04;
const SPEECH_VOICED_EXIT_THRESHOLD = 0.018;
const SPEECH_EMPHASIS_RISE_THRESHOLD_PER_SECOND = 1.5;
const SPEECH_EMPHASIS_RISE_GAIN = 0.09;
const SPEECH_EMPHASIS_ATTACK_PER_SECOND = 18.0;
const SPEECH_EMPHASIS_RELEASE_PER_SECOND = 7.0;
const SPEECH_EMPHASIS_MAX = 0.42;
const SPEECH_HEAD_EMPHASIS_GAIN = 0.34;
const SPEECH_BODY_EMPHASIS_GAIN = 0.18;
const LIP_SYNC_DIAGNOSTIC_FRAME_LIMIT = 2;

/**
 * Owns the transient audio signal for one attached playback source. This is
 * deliberately separate from parameter composition: it converts audio facts
 * into stable speech envelopes, but never resolves or writes model parameters.
 */
export class SpeechSignalRuntime {
  private activeSourceId: string | null = null;
  private lipSyncIntensity = 0;
  private speechEnergyValue = 0;
  private speechHeadEnvelope = 0;
  private speechBodyEnvelope = 0;
  private speechEmphasisEnvelope = 0;
  private speechVoiced = false;
  private lipSyncDiagnosticFrameCount = 0;
  private activeSourceFailureHandler: ((reason: string) => void) | null = null;

  public beginSource(
    sourceId: string,
    options: ExternalAudioSignalSourceOptions = {},
  ): void {
    const normalizedSourceId = normalizeSourceId(sourceId);
    if (this.activeSourceId !== null) {
      throw new Error(`speech_signal_source_already_active:${this.activeSourceId}`);
    }
    this.activeSourceId = normalizedSourceId;
    this.lipSyncIntensity = 0;
    this.speechEnergyValue = 0;
    this.speechEmphasisEnvelope = 0;
    this.speechVoiced = false;
    this.lipSyncDiagnosticFrameCount = 0;
    this.activeSourceFailureHandler = typeof options.onFailed === "function"
      ? options.onFailed
      : null;
  }

  public writeSource(
    sourceId: string,
    values: ExternalAudioSignalValues,
  ): void {
    this.requireActiveSource(sourceId);
    if (values.lipSyncIntensity !== undefined) {
      this.lipSyncIntensity = validateNormalizedSignal(
        values.lipSyncIntensity,
        "speech_signal_invalid_lip_sync_intensity",
      );
    }
    if (values.speechEnergyValue !== undefined) {
      this.speechEnergyValue = validateNormalizedSignal(
        values.speechEnergyValue,
        "speech_signal_invalid_energy_value",
      );
    }
  }

  public endSource(sourceId: string): void {
    const normalizedSourceId = normalizeSourceId(sourceId);
    if (this.activeSourceId === null) {
      return;
    }
    if (this.activeSourceId !== normalizedSourceId) {
      throw new Error(
        `speech_signal_source_mismatch:${normalizedSourceId}:${this.activeSourceId}`,
      );
    }
    this.clearActiveSource();
  }

  public failActiveSource(reason: string): void {
    const normalizedReason = normalizeFailureReason(reason);
    if (this.activeSourceId === null) {
      return;
    }

    const failureHandler = this.activeSourceFailureHandler;
    this.clearActiveSource();
    if (!failureHandler) {
      return;
    }
    try {
      failureHandler(normalizedReason);
    } catch (error) {
      console.error("[SpeechSignalRuntime] source failure callback failed.", {
        reason: normalizedReason,
        error,
      });
    }
  }

  public reset(): void {
    this.clearActiveSource();
    this.speechHeadEnvelope = 0;
    this.speechBodyEnvelope = 0;
  }

  public advanceFrame(deltaTimeSeconds: number, includeLipSync: boolean): SpeechAudioFrame {
    const speechEnergy = this.activeSourceId === null ? 0 : this.speechEnergyValue;
    if (this.activeSourceId === null) {
      this.speechVoiced = false;
    } else if (this.speechVoiced) {
      this.speechVoiced = speechEnergy > SPEECH_VOICED_EXIT_THRESHOLD;
    } else {
      this.speechVoiced = speechEnergy >= SPEECH_VOICED_ENTER_THRESHOLD;
    }
    const speechTargetEnergy = this.speechVoiced ? speechEnergy : 0;
    const previousSpeechHeadEnvelope = this.speechHeadEnvelope;
    this.speechHeadEnvelope = advanceEnvelope(
      this.speechHeadEnvelope,
      speechTargetEnergy,
      deltaTimeSeconds,
      SPEECH_HEAD_ENVELOPE_ATTACK_PER_SECOND,
      SPEECH_HEAD_ENVELOPE_RELEASE_PER_SECOND,
    );
    this.speechBodyEnvelope = advanceEnvelope(
      this.speechBodyEnvelope,
      speechTargetEnergy,
      deltaTimeSeconds,
      SPEECH_BODY_ENVELOPE_ATTACK_PER_SECOND,
      SPEECH_BODY_ENVELOPE_RELEASE_PER_SECOND,
    );
    const positiveHeadEnvelopeDelta = Math.max(
      0,
      this.speechHeadEnvelope - previousSpeechHeadEnvelope,
    );
    const positiveHeadEnvelopeRise = deltaTimeSeconds > 0
      ? positiveHeadEnvelopeDelta / deltaTimeSeconds
      : 0;
    const emphasisTarget = this.speechVoiced
      ? clamp(
          (positiveHeadEnvelopeRise - SPEECH_EMPHASIS_RISE_THRESHOLD_PER_SECOND)
            * SPEECH_EMPHASIS_RISE_GAIN,
          0,
          SPEECH_EMPHASIS_MAX,
        )
      : 0;
    this.speechEmphasisEnvelope = advanceEnvelope(
      this.speechEmphasisEnvelope,
      emphasisTarget,
      deltaTimeSeconds,
      SPEECH_EMPHASIS_ATTACK_PER_SECOND,
      SPEECH_EMPHASIS_RELEASE_PER_SECOND,
    );
    if (this.speechHeadEnvelope < 0.001) {
      this.speechHeadEnvelope = 0;
    }
    if (this.speechBodyEnvelope < 0.001) {
      this.speechBodyEnvelope = 0;
    }
    if (this.speechEmphasisEnvelope < 0.001) {
      this.speechEmphasisEnvelope = 0;
    }

    const lipSyncActive = includeLipSync && this.activeSourceId !== null;
    return {
      lipSyncActive,
      lipSyncIntensity: lipSyncActive
        ? this.lipSyncIntensity
        : 0,
    };
  }

  public getSpeechAudioGain(axisId: string): number {
    const channelName = axisId.startsWith("voice_following.")
      ? axisId.slice("voice_following.".length).split("|")[0]
      : axisId;
    const activityFloor = this.speechVoiced
      ? channelName.startsWith("body_")
        ? SPEECH_BODY_ACTIVITY_FLOOR
        : SPEECH_HEAD_ACTIVITY_FLOOR
      : 0;
    const rawGain = channelName.startsWith("body_")
      ? Math.min(
          SPEECH_BODY_GAIN_MAX,
          activityFloor
            + this.speechBodyEnvelope * SPEECH_BODY_GAIN_SPAN
            + this.speechEmphasisEnvelope * SPEECH_BODY_EMPHASIS_GAIN,
        )
      : Math.min(
          SPEECH_AUDIO_GAIN_MAX,
          activityFloor
            + this.speechHeadEnvelope * SPEECH_AUDIO_GAIN_SPAN
            + this.speechEmphasisEnvelope * SPEECH_HEAD_EMPHASIS_GAIN,
        );
    return channelName.includes("pitch")
      ? Math.min(SPEECH_AUDIO_PITCH_GAIN_MAX, rawGain)
      : rawGain;
  }

  public getLipSyncDiagnosticSourceId(): string | null {
    if (
      this.activeSourceId === null
      || this.lipSyncDiagnosticFrameCount >= LIP_SYNC_DIAGNOSTIC_FRAME_LIMIT
    ) {
      return null;
    }
    return this.activeSourceId;
  }

  public markLipSyncDiagnosticFrameLogged(sourceId: string): void {
    this.requireActiveSource(sourceId);
    if (this.lipSyncDiagnosticFrameCount < LIP_SYNC_DIAGNOSTIC_FRAME_LIMIT) {
      this.lipSyncDiagnosticFrameCount += 1;
    }
  }

  private requireActiveSource(sourceId: string): void {
    const normalizedSourceId = normalizeSourceId(sourceId);
    if (this.activeSourceId !== normalizedSourceId) {
      throw new Error(
        `speech_signal_source_mismatch:${normalizedSourceId}:${this.activeSourceId ?? "none"}`,
      );
    }
  }

  private clearActiveSource(): void {
    this.activeSourceId = null;
    this.activeSourceFailureHandler = null;
    this.lipSyncIntensity = 0;
    this.speechEnergyValue = 0;
    this.speechEmphasisEnvelope = 0;
    this.speechVoiced = false;
    this.lipSyncDiagnosticFrameCount = 0;
  }
}

function normalizeSourceId(sourceId: string): string {
  const normalized = typeof sourceId === "string" ? sourceId.trim() : "";
  if (!normalized) {
    throw new Error("speech_signal_source_id_missing");
  }
  return normalized;
}

function normalizeFailureReason(reason: string): string {
  const normalized = typeof reason === "string" ? reason.trim() : "";
  if (!normalized) {
    throw new Error("speech_signal_failure_reason_missing");
  }
  return normalized;
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
