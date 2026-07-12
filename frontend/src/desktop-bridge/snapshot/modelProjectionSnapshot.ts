import type {
  DesktopBaseActionPreview,
  DesktopModelProjectionSnapshot,
} from "../../types/desktop.js";
import type { SemanticAxisProfile } from "../../types/semantic-axis-profile.js";
import { cloneMotionTuningEffectiveExample } from "./motionTuningSnapshot.js";
import {
  cloneNumericRecord,
  isObject,
  isPresent,
  normalizeText,
} from "../../utils/guards.js";

export const defaultModelProjectionSnapshot: DesktopModelProjectionSnapshot = {
  selectedModelName: "",
  selectedModelIconUrl: "",
  recommendedMode: "",
  confName: "",
  lastUpdated: "",
  runtimeSemanticAxisProfile: null,
  baseActionPreview: null,
  motionTuningEffectiveExamples: [],
};

export function safeNormalizeModelProjectionSnapshot(
  snapshot: unknown,
  source: string,
): DesktopModelProjectionSnapshot | null {
  try {
    if (!isObject(snapshot)) {
      throw new Error("model_projection_snapshot_not_object");
    }
    return normalizeModelProjectionSnapshot(
      snapshot as unknown as DesktopModelProjectionSnapshot,
    );
  } catch (error) {
    console.warn(
      `[DesktopBridge] ${source} model projection snapshot rejected.`,
      error,
    );
    return null;
  }
}

export function normalizeModelProjectionSnapshot(
  snapshot: DesktopModelProjectionSnapshot,
): DesktopModelProjectionSnapshot {
  return {
    ...defaultModelProjectionSnapshot,
    ...snapshot,
    selectedModelName: normalizeText(snapshot.selectedModelName),
    selectedModelIconUrl: normalizeText(snapshot.selectedModelIconUrl),
    recommendedMode: normalizeText(snapshot.recommendedMode),
    confName: normalizeText(snapshot.confName),
    lastUpdated: normalizeText(snapshot.lastUpdated),
    runtimeSemanticAxisProfile: cloneSemanticAxisProfile(
      snapshot.runtimeSemanticAxisProfile,
    ),
    baseActionPreview: cloneBaseActionPreview(snapshot.baseActionPreview),
    motionTuningEffectiveExamples: Array.isArray(snapshot.motionTuningEffectiveExamples)
      ? snapshot.motionTuningEffectiveExamples
        .map(cloneMotionTuningEffectiveExample)
        .filter(isPresent)
      : [],
  };
}

function cloneBaseActionPreview(
  preview: DesktopBaseActionPreview | null,
): DesktopBaseActionPreview | null {
  if (!preview) {
    return null;
  }
  return {
    ...preview,
    focusChannels: [...preview.focusChannels],
    focusDomains: [...preview.focusDomains],
    ignoredDomains: [...preview.ignoredDomains],
    summary: { ...preview.summary },
    analysis: { ...preview.analysis },
    families: preview.families.map((family) => ({
      ...family,
      channels: [...family.channels],
    })),
    channels: preview.channels.map((channel) => ({
      ...channel,
      polarityModes: [...channel.polarityModes],
      atomIds: [...channel.atomIds],
    })),
    atoms: preview.atoms.map((atom) => ({
      ...atom,
      sourceTags: [...atom.sourceTags],
    })),
  };
}

function cloneSemanticAxisProfile(
  profile: SemanticAxisProfile | null | undefined,
): SemanticAxisProfile | null {
  if (!profile) {
    return null;
  }
  return {
    ...profile,
    axes: profile.axes.map((axis) => ({
      ...axis,
      value_range: [...axis.value_range] as [number, number],
      soft_range: [...axis.soft_range] as [number, number],
      strong_range: [...axis.strong_range] as [number, number],
      dynamics: { ...axis.dynamics },
      positive_semantics: [...axis.positive_semantics],
      negative_semantics: [...axis.negative_semantics],
      parameter_bindings: axis.parameter_bindings.map((binding) => ({
        ...binding,
        input_range: [...binding.input_range] as [number, number],
        output_range: [...binding.output_range] as [number, number],
      })),
    })),
    couplings: profile.couplings.map((coupling) => ({ ...coupling })),
    relation_graph: {
      schema_version: profile.relation_graph.schema_version,
      edges: profile.relation_graph.edges.map((edge) => ({ ...edge })),
    },
  };
}
