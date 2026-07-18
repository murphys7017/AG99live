export interface PayloadParseError {
  code: "invalid_payload";
  message: string;
  path: string;
}

export type PayloadParseResult<TPayload> =
  | { ok: true; payload: TPayload }
  | { ok: false; error: PayloadParseError };

export function invalidPayload(
  type: string,
  path: string,
  expected: string,
): PayloadParseResult<never> {
  return {
    ok: false,
    error: {
      code: "invalid_payload",
      path,
      message: `收到非法协议载荷（type=${type}, path=${path}, expected=${expected}）。`,
    },
  };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function validateExactKeys(
  type: string,
  path: string,
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): PayloadParseResult<null> {
  const allowed = new Set(allowedKeys);
  const unknownKey = Object.keys(record).find((key) => !allowed.has(key));
  if (unknownKey) {
    return invalidPayload(type, `${path}.${unknownKey}`, "declared protocol field");
  }
  return { ok: true, payload: null };
}

export function requiredString(
  type: string,
  record: Record<string, unknown>,
  key: string,
): PayloadParseResult<string> {
  const value = record[key];
  if (typeof value !== "string") {
    return invalidPayload(type, `payload.${key}`, "string");
  }
  return { ok: true, payload: value };
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function requiredBoolean(
  type: string,
  record: Record<string, unknown>,
  key: string,
): PayloadParseResult<boolean> {
  const value = record[key];
  if (typeof value !== "boolean") {
    return invalidPayload(type, `payload.${key}`, "boolean");
  }
  return { ok: true, payload: value };
}

export function requiredNumber(
  type: string,
  record: Record<string, unknown>,
  key: string,
): PayloadParseResult<number> {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalidPayload(type, `payload.${key}`, "finite number");
  }
  return { ok: true, payload: value };
}
