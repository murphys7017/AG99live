import type {
  DesktopBaseActionPreview,
  DesktopExpressionExample,
  DesktopModelProjectionSnapshot,
} from "../../types/desktop";
import type { SemanticAxisProfile } from "../../types/semantic-axis-profile";
import { cloneMotionTuningEffectiveExample } from "./motionTuningSnapshot";
import {
  cloneNumericRecord,
  isObject,
  isPresent,
  normalizeText,
} from "../../utils/guards";

export const defaultModelProjectionSnapshot: DesktopModelProjectionSnapshot = {
  selectedModelName: "",
  selectedModelIconUrl: "",
  recommendedMode: "",
  confName: "",
  lastUpdated: "",
  runtimeSemanticAxisProfile: null,
  baseActionPreview: null,
  motionTuningEffectiveExamples: [],
  expressionExamples: [],
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
    expressionExamples: Array.isArray(snapshot.expressionExamples)
      ? snapshot.expressionExamples
        .map(normalizeExpressionExample)
        .filter(isPresent)
      : [],
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
      positive_semantics: [...axis.positive_semantics],
      negative_semantics: [...axis.negative_semantics],
      parameter_bindings: axis.parameter_bindings.map((binding) => ({
        ...binding,
        input_range: [...binding.input_range] as [number, number],
        output_range: [...binding.output_range] as [number, number],
      })),
    })),
    couplings: profile.couplings.map((coupling) => ({ ...coupling })),
  };
}

function normalizeExpressionExample(
  value: unknown,
): DesktopExpressionExample | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = normalizeText(candidate.id);
  const modelName = normalizeText(candidate.modelName);
  const name = normalizeText(candidate.name);
  const category = normalizeText(candidate.category);
  const sourceFile = normalizeText(candidate.source_file);
  const emotionLabel = normalizeText(candidate.emotion_label);
  const tags = Array.isArray(candidate.tags)
    ? candidate.tags.map((t) => normalizeText(t)).filter(Boolean)
    : [];
  const axes = candidate.axes && typeof candidate.axes === "object" && !Array.isArray(candidate.axes)
    ? cloneNumericRecord(candidate.axes as Record<string, unknown>)
    : {};
  const enabled = candidate.enabled !== false;
  const feedback = normalizeText(candidate.feedback);
  if (!id || Object.keys(axes).length === 0) {
    return null;
  }
  return {
    modelName,
    id,
    name: name || id,
    category: category || "",
    source_file: sourceFile,
    emotion_label: emotionLabel || id,
    tags,
    axes,
    enabled,
    feedback,
    source: "model_native",
  };
}
