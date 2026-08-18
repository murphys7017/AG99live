import type {
  DirectParameterExecutionPlan,
  DirectParameterResponsePolicy,
} from "./directparameterplan";

const MAX_SPRING_STEP_SECONDS = 1 / 120;
const SETTLED_VALUE_EPSILON = 0.001;
const SETTLED_VELOCITY_EPSILON = 0.001;

export interface ParameterPresentationNode {
  parameterId: string;
  initialValue: number;
  neutralValue: number;
  maxVelocity: number;
  maxAcceleration: number;
  response: DirectParameterResponsePolicy;
  drivenValue: number | null;
  velocity: number;
  lastElapsedMs: number | null;
}

export interface ParameterPresentationTrackPoint {
  atMs: number;
  transitionMs: number;
  value: number;
}

export function resolveParameterPresentationFrame(
  node: ParameterPresentationNode,
  frameTargetValue: number,
  elapsedMs: number,
  timing: DirectParameterExecutionPlan["timing"],
): { drivenValue: number; settled: boolean } {
  const targetValue = resolveTrajectoryEnvelope(node, frameTargetValue, elapsedMs, timing);
  const previousValue = node.drivenValue ?? node.initialValue;
  const previousElapsedMs = node.lastElapsedMs;
  node.lastElapsedMs = elapsedMs;

  if (previousElapsedMs === null || elapsedMs <= previousElapsedMs) {
    node.drivenValue = previousValue;
    node.velocity = 0;
    return {
      drivenValue: node.drivenValue,
      settled: isParameterPresentationSettled(node.drivenValue, targetValue, node.velocity),
    };
  }

  const deltaSeconds = (elapsedMs - previousElapsedMs) / 1000;
  const next = advanceParameterDynamics(
    previousValue,
    targetValue,
    node.velocity,
    deltaSeconds,
    node.maxVelocity,
    node.maxAcceleration,
    node.response,
  );
  node.drivenValue = next.value;
  node.velocity = next.velocity;
  return {
    drivenValue: next.value,
    settled: isParameterPresentationSettled(next.value, targetValue, next.velocity),
  };
}

export function resolveParameterOwnershipWeight(
  elapsedMs: number,
  timing: DirectParameterExecutionPlan["timing"],
): number {
  const blendOutMs = Math.max(0, timing.blendOutMs);
  const releaseStartMs = Math.max(0, timing.totalMs - blendOutMs);
  if (elapsedMs < releaseStartMs) {
    return 1;
  }
  if (blendOutMs === 0 || elapsedMs >= timing.totalMs) {
    return 0;
  }
  return smoothstep(1 - (elapsedMs - releaseStartMs) / blendOutMs);
}

export function resolveParameterPresentationTrack(
  points: ParameterPresentationTrackPoint[],
  elapsedMs: number,
  fallbackValue: number,
): number {
  if (points.length < 2) {
    return fallbackValue;
  }
  let previous = points[0];
  for (let index = 1; index < points.length; index += 1) {
    const next = points[index];
    if (elapsedMs < next.atMs) {
      return previous.value;
    }
    const transitionEndMs = next.atMs + next.transitionMs;
    if (next.transitionMs > 0 && elapsedMs < transitionEndMs) {
      return interpolate(
        previous.value,
        next.value,
        clampUnit((elapsedMs - next.atMs) / next.transitionMs),
      );
    }
    previous = next;
  }
  return previous.value;
}

function resolveTrajectoryEnvelope(
  node: ParameterPresentationNode,
  frameTargetValue: number,
  elapsedMs: number,
  timing: DirectParameterExecutionPlan["timing"],
): number {
  const elapsed = Math.max(0, elapsedMs);
  const blendInMs = Math.max(0, timing.blendInMs);
  const holdMs = Math.max(0, timing.holdMs);

  if (blendInMs > 0 && elapsed < blendInMs) {
    const progress = elapsed / blendInMs;
    if (timing.curvePreset === "slow_build_quick_release") {
      return interpolate(node.initialValue, frameTargetValue, progress * progress);
    }
    if (timing.curvePreset === "pulse_settle") {
      return interpolate(
        node.initialValue,
        frameTargetValue,
        Math.min(1.08, easeOutBack(progress)),
      );
    }
    // Standard entry is solved by the response policy below. Only explicit
    // curve presets are allowed to shape the target trajectory here.
    return frameTargetValue;
  }

  if (elapsed < blendInMs + holdMs) {
    if (
      timing.curvePreset === "breathing_swell"
      || timing.curvePreset === "pulse_settle"
    ) {
      const progress = holdMs > 0 ? (elapsed - blendInMs) / holdMs : 1;
      return interpolate(
        node.neutralValue,
        frameTargetValue,
        1 - 0.06 * Math.sin(Math.PI * progress),
      );
    }
    return frameTargetValue;
  }

  return frameTargetValue;
}

function advanceParameterDynamics(
  previousValue: number,
  targetValue: number,
  previousVelocity: number,
  deltaSeconds: number,
  maxVelocity: number,
  maxAcceleration: number,
  response: DirectParameterResponsePolicy,
): { value: number; velocity: number } {
  if (response.kind === "spring") {
    return advanceSpringParameterDynamics(
      previousValue,
      targetValue,
      previousVelocity,
      deltaSeconds,
      maxVelocity,
      maxAcceleration,
      response.frequency_hz,
      response.damping_ratio,
    );
  }
  return advanceBoundedParameterDynamics(
    previousValue,
    targetValue,
    previousVelocity,
    deltaSeconds,
    maxVelocity,
    maxAcceleration,
  );
}

function isParameterPresentationSettled(
  value: number,
  targetValue: number,
  velocity: number,
): boolean {
  return Math.abs(targetValue - value) <= SETTLED_VALUE_EPSILON
    && Math.abs(velocity) <= SETTLED_VELOCITY_EPSILON;
}

function advanceBoundedParameterDynamics(
  previousValue: number,
  targetValue: number,
  previousVelocity: number,
  deltaSeconds: number,
  maxVelocity: number,
  maxAcceleration: number,
): { value: number; velocity: number } {
  const remaining = targetValue - previousValue;
  const velocityDelta = maxAcceleration * deltaSeconds;
  if (Math.abs(remaining) <= 0.001 && Math.abs(previousVelocity) <= velocityDelta) {
    return { value: targetValue, velocity: 0 };
  }

  const direction = Math.sign(remaining);
  const brakingSpeed = Math.sqrt(2 * maxAcceleration * Math.abs(remaining));
  const desiredVelocity = direction * Math.min(maxVelocity, brakingSpeed);
  const nextVelocity = clampRange(
    desiredVelocity,
    previousVelocity - velocityDelta,
    previousVelocity + velocityDelta,
  );
  const unboundedValue = previousValue + nextVelocity * deltaSeconds;
  const crossedTarget = direction !== 0
    && Math.sign(targetValue - unboundedValue) !== direction;
  if (crossedTarget) {
    return { value: targetValue, velocity: 0 };
  }

  const nextValue = unboundedValue;
  const nextRemaining = targetValue - nextValue;
  if (Math.abs(nextRemaining) <= 0.001 && Math.abs(nextVelocity) <= velocityDelta) {
    return { value: targetValue, velocity: 0 };
  }
  return { value: nextValue, velocity: nextVelocity };
}

function advanceSpringParameterDynamics(
  previousValue: number,
  targetValue: number,
  previousVelocity: number,
  deltaSeconds: number,
  maxVelocity: number,
  maxAcceleration: number,
  frequencyHz: number,
  dampingRatio: number,
): { value: number; velocity: number } {
  const stepCount = Math.max(
    1,
    Math.ceil(deltaSeconds / MAX_SPRING_STEP_SECONDS),
  );
  const stepSeconds = deltaSeconds / stepCount;
  let value = previousValue;
  let velocity = previousVelocity;
  for (let index = 0; index < stepCount; index += 1) {
    const next = advanceSpringParameterDynamicsStep(
      value,
      targetValue,
      velocity,
      stepSeconds,
      maxVelocity,
      maxAcceleration,
      frequencyHz,
      dampingRatio,
    );
    value = next.value;
    velocity = next.velocity;
  }
  return { value, velocity };
}

function advanceSpringParameterDynamicsStep(
  previousValue: number,
  targetValue: number,
  previousVelocity: number,
  deltaSeconds: number,
  maxVelocity: number,
  maxAcceleration: number,
  frequencyHz: number,
  dampingRatio: number,
): { value: number; velocity: number } {
  const remaining = targetValue - previousValue;
  const velocityDelta = maxAcceleration * deltaSeconds;
  if (Math.abs(remaining) <= 0.001 && Math.abs(previousVelocity) <= velocityDelta) {
    return { value: targetValue, velocity: 0 };
  }

  const desiredVelocity = resolveDampedSpringVelocity(
    previousValue,
    targetValue,
    previousVelocity,
    deltaSeconds,
    frequencyHz,
    dampingRatio,
  );
  const accelerationLimitedVelocity = clampRange(
    desiredVelocity,
    previousVelocity - velocityDelta,
    previousVelocity + velocityDelta,
  );
  const nextVelocity = clampRange(
    accelerationLimitedVelocity,
    -maxVelocity,
    maxVelocity,
  );
  const nextValue = previousValue
    + (previousVelocity + nextVelocity) * 0.5 * deltaSeconds;
  if (
    Math.abs(targetValue - nextValue) <= 0.001
    && Math.abs(nextVelocity) <= velocityDelta
  ) {
    return { value: targetValue, velocity: 0 };
  }
  return { value: nextValue, velocity: nextVelocity };
}

function resolveDampedSpringVelocity(
  previousValue: number,
  targetValue: number,
  previousVelocity: number,
  deltaSeconds: number,
  frequencyHz: number,
  dampingRatio: number,
): number {
  const displacement = previousValue - targetValue;
  const angularFrequency = 2 * Math.PI * frequencyHz;
  const dampedFrequency = angularFrequency * Math.sqrt(1 - dampingRatio ** 2);
  const decay = Math.exp(-dampingRatio * angularFrequency * deltaSeconds);
  const phase = dampedFrequency * deltaSeconds;
  const cosine = Math.cos(phase);
  const sine = Math.sin(phase);
  const velocityTerm = (
    previousVelocity + dampingRatio * angularFrequency * displacement
  ) / dampedFrequency;
  const projectedDisplacement = displacement * cosine + velocityTerm * sine;
  return decay * (
    -dampingRatio * angularFrequency * projectedDisplacement
    - displacement * dampedFrequency * sine
    + velocityTerm * dampedFrequency * cosine
  );
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function smoothstep(value: number): number {
  const x = clampUnit(value);
  return x * x * (3 - 2 * x);
}

function easeOutBack(value: number): number {
  const x = clampUnit(value) - 1;
  return 1 + 2.70158 * x * x * x + 1.70158 * x * x;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampRange(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}
