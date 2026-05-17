export function normalizeTurnIdForComparison(turnId: string | null | undefined): string {
  return typeof turnId === "string" ? turnId.trim() : "";
}
