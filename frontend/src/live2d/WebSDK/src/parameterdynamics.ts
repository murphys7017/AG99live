export interface ParameterDynamicsStep {
  value: number;
  velocity: number;
}

export function advanceParameterDynamics(
  previousValue: number,
  targetValue: number,
  previousVelocity: number,
  deltaSeconds: number,
  maxVelocity: number,
  maxAcceleration: number,
  minValue: number,
  maxValue: number,
): ParameterDynamicsStep {
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

function clamp(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}
