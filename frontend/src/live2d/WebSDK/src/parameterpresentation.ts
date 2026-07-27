import type { DirectParameterExecutionPlan } from "./directparameterplan";

export interface ParameterPresentationNode {
  parameterId: string;
  initialValue: number;
  neutralValue: number;
  minValue: number;
  maxValue: number;
  maxVelocity: number;
  maxAcceleration: number;
  drivenValue: number | null;
  velocity: number;
  lastElapsedMs: number | null;
}

export interface ParameterPresentationTrackPoint {
  atMs: number;
  transitionMs: number;
  value: number;
}

export interface ParameterPresentationFrame {
  targetValue: number;
  drivenValue: number;
  ownershipWeight: number;
  released: boolean;
}

export function resolveParameterPresentationFrame(
  node: ParameterPresentationNode,
  frameTargetValue: number,
  elapsedMs: number,
  timing: DirectParameterExecutionPlan["timing"],
): ParameterPresentationFrame {
  const targetValue = clamp(
    resolveTrajectoryEnvelope(node, frameTargetValue, elapsedMs, timing),
    node.minValue,
    node.maxValue,
  );
  const previousValue = node.drivenValue ?? node.initialValue;
  const previousElapsedMs = node.lastElapsedMs;
  node.lastElapsedMs = elapsedMs;

  if (previousElapsedMs === null || elapsedMs <= previousElapsedMs) {
    node.drivenValue = clamp(previousValue, node.minValue, node.maxValue);
    node.velocity = 0;
    const ownershipWeight = resolveOwnershipWeight(elapsedMs, timing);
    return {
      targetValue,
      drivenValue: node.drivenValue,
      ownershipWeight,
      released: ownershipWeight === 0,
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
    node.minValue,
    node.maxValue,
  );
  node.drivenValue = next.value;
  node.velocity = next.velocity;
  const ownershipWeight = resolveOwnershipWeight(elapsedMs, timing);
  return {
    targetValue,
    drivenValue: next.value,
    ownershipWeight,
    released: ownershipWeight === 0,
  };
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
        smoothstep((elapsedMs - next.atMs) / next.transitionMs),
      );
    }
    previous = next;
  }
  return previous.value;
}

function resolveOwnershipWeight(
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
    return interpolate(node.initialValue, frameTargetValue, smoothstep(progress));
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
  minValue: number,
  maxValue: number,
): { value: number; velocity: number } {
  const remaining = targetValue - previousValue;
  const velocityDelta = maxAcceleration * deltaSeconds;
  if (Math.abs(remaining) <= 0.001 && Math.abs(previousVelocity) <= velocityDelta) {
    return { value: targetValue, velocity: 0 };
  }

  const direction = Math.sign(remaining);
  const brakingSpeed = Math.sqrt(2 * maxAcceleration * Math.abs(remaining));
  const desiredVelocity = direction * Math.min(maxVelocity, brakingSpeed);
  const nextVelocity = clamp(
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

  const nextValue = clamp(unboundedValue, minValue, maxValue);
  if (nextValue !== unboundedValue) {
    return { value: nextValue, velocity: 0 };
  }
  const nextRemaining = targetValue - nextValue;
  if (Math.abs(nextRemaining) <= 0.001 && Math.abs(nextVelocity) <= velocityDelta) {
    return { value: targetValue, velocity: 0 };
  }
  return { value: nextValue, velocity: nextVelocity };
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function smoothstep(value: number): number {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

function easeOutBack(value: number): number {
  const x = clamp(value, 0, 1) - 1;
  return 1 + 2.70158 * x * x * x + 1.70158 * x * x;
}

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}
