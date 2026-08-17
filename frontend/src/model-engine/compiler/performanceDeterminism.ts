export function clampInteger(
  value: number,
  minValue: number,
  maxValue: number,
): number {
  return Math.round(Math.max(minValue, Math.min(maxValue, value)));
}

export function hashPerformanceIdentity(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function performanceUnitInterval(seed: number): number {
  return (seed >>> 0) / 0xffffffff;
}
