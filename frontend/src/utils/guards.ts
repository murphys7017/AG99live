export function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isPresent<TValue>(value: TValue | null): value is TValue {
  return value !== null;
}

export function normalizeOptionalText(value: unknown): string | undefined {
  const normalized = normalizeText(value);
  return normalized || undefined;
}

export function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.map((item) => normalizeText(item)).filter(Boolean);
  return normalized.length ? normalized : undefined;
}

export function normalizeOptionalInteger(value: unknown): number | undefined {
  if (!isFiniteNumber(value)) {
    return undefined;
  }
  return Math.max(0, Math.round(value));
}

export function cloneNumericRecord(value: unknown): Record<string, number> {
  if (!isObject(value)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isFiniteNumber(item)) {
      result[key] = item;
    }
  }
  return result;
}
