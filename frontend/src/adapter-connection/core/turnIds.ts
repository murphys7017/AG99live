import { normalizeIdentityPart } from "../../turn-playback/identity.js";

export function normalizeTurnIdForComparison(turnId: string | null | undefined): string {
  return normalizeIdentityPart(turnId);
}
