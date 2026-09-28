export type StructuralSemanticGroup = "gaze" | "head" | "body" | "face";

export const SKELETON_COMPOSITION_GROUPS = ["gaze", "head", "body"] as const;

export function normalizeSemanticGroup(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function resolveStructuralSemanticGroup(
  value: unknown,
): StructuralSemanticGroup | null {
  const group = normalizeSemanticGroup(value);
  if (group === "gaze" || group === "head") {
    return group;
  }
  if (group === "body" || group === "torso" || group === "shoulder") {
    return "body";
  }
  if (group === "eye" || group === "mouth" || group === "brow" || group === "face") {
    return "face";
  }
  return null;
}

export function resolveAxisSamplingGroup(value: unknown): string {
  const structuralGroup = resolveStructuralSemanticGroup(value);
  if (
    structuralGroup === "gaze"
    || structuralGroup === "head"
    || structuralGroup === "body"
  ) {
    return "skeleton";
  }
  if (structuralGroup === "face") {
    return "face";
  }
  return normalizeSemanticGroup(value) || "axis";
}
