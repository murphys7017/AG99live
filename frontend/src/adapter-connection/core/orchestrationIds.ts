export function normalizeTurnIdForComparison(turnId: string | null | undefined): string {
  return typeof turnId === "string" ? turnId.trim() : "";
}

export function normalizeOrchestrationId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}
