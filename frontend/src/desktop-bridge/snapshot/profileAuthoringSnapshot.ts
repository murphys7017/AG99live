import type { DesktopProfileAuthoringSnapshot } from "../../types/desktop";
import { isObject } from "../../utils/guards";

export const defaultProfileAuthoringSnapshot: DesktopProfileAuthoringSnapshot = {
  latestSemanticAxisProfileSaveResult: null,
};

export function safeNormalizeProfileAuthoringSnapshot(
  snapshot: unknown,
  source: string,
): DesktopProfileAuthoringSnapshot | null {
  try {
    if (!isObject(snapshot)) {
      throw new Error("profile_authoring_snapshot_not_object");
    }
    return normalizeProfileAuthoringSnapshot(
      snapshot as unknown as DesktopProfileAuthoringSnapshot,
    );
  } catch (error) {
    console.warn(
      `[DesktopBridge] ${source} profile authoring snapshot rejected.`,
      error,
    );
    return null;
  }
}

export function normalizeProfileAuthoringSnapshot(
  snapshot: DesktopProfileAuthoringSnapshot,
): DesktopProfileAuthoringSnapshot {
  return {
    latestSemanticAxisProfileSaveResult: snapshot.latestSemanticAxisProfileSaveResult
      ? { ...snapshot.latestSemanticAxisProfileSaveResult }
      : null,
  };
}
