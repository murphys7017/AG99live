import {
  SCHEMA_MOTION_INTENT_V4,
  type ModelSummary,
  type MotionAxisValueStep,
  type MotionMaterialCatalog,
  type MotionMaterialFragment,
  type NormalizedSemanticMotionIntent,
  type ParameterActionAtom,
} from "../../types/protocol.js";
import type { SemanticAxisDefinition } from "../../types/semantic-axis-profile.js";

export type MaterialCompositionRecipeId =
  | "calm_companion"
  | "quiet_thinking"
  | "gentle_acknowledge"
  | "tired_waiting"
  | "speech_gap";

export interface MaterialCompositionRecipe {
  id: MaterialCompositionRecipeId;
  emotionLabel: string;
  bodyChannels: readonly string[];
  overlayChannels: readonly string[];
  maxOverlays: number;
  durationMs: readonly [number, number];
  intensityScale: number;
  preferredTags: readonly string[];
}

export interface MaterialMotionCompositionOptions {
  model: ModelSummary;
  recipeId: MaterialCompositionRecipeId;
  seed: string | number;
  allowedAxisIds: readonly string[];
  reservedChannels?: readonly string[];
}

export interface MaterialMotionCompositionMetadata {
  source: "material_composition";
  recipeId: MaterialCompositionRecipeId;
  seed: string;
  fragmentIds: string[];
  atomIds: string[];
  diagnostics: string[];
}

export type MaterialMotionCompositionResult =
  | {
    ok: true;
    intent: Extract<NormalizedSemanticMotionIntent, { motion_steps: MotionAxisValueStep[] }>;
    metadata: MaterialMotionCompositionMetadata;
  }
  | {
    ok: false;
    reason: string;
    metadata: MaterialMotionCompositionMetadata;
  };

export const MATERIAL_COMPOSITION_RECIPES: Readonly<
  Record<MaterialCompositionRecipeId, MaterialCompositionRecipe>
> = {
  calm_companion: {
    id: "calm_companion",
    emotionLabel: "calm",
    bodyChannels: ["head_yaw", "head_roll", "body_yaw", "body_roll", "gaze_x", "gaze_y"],
    overlayChannels: ["breath", "gaze_x", "gaze_y"],
    maxOverlays: 2,
    durationMs: [4200, 6000],
    intensityScale: 0.42,
    preferredTags: ["idle", "calm", "soft", "companion"],
  },
  quiet_thinking: {
    id: "quiet_thinking",
    emotionLabel: "thinking",
    bodyChannels: ["head_yaw", "head_pitch", "head_roll", "gaze_x", "gaze_y"],
    overlayChannels: ["body_yaw", "body_roll", "breath"],
    maxOverlays: 2,
    durationMs: [1000, 2800],
    intensityScale: 0.34,
    preferredTags: ["think", "thinking", "idle", "wait"],
  },
  gentle_acknowledge: {
    id: "gentle_acknowledge",
    emotionLabel: "acknowledge",
    bodyChannels: ["head_pitch", "head_yaw", "body_pitch", "body_yaw"],
    overlayChannels: ["gaze_x", "gaze_y", "breath"],
    maxOverlays: 2,
    durationMs: [700, 1900],
    intensityScale: 0.38,
    preferredTags: ["nod", "agree", "gentle", "soft"],
  },
  tired_waiting: {
    id: "tired_waiting",
    emotionLabel: "tired",
    bodyChannels: ["head_pitch", "head_roll", "body_pitch", "body_roll"],
    overlayChannels: ["breath", "gaze_x"],
    maxOverlays: 2,
    durationMs: [1400, 3400],
    intensityScale: 0.28,
    preferredTags: ["tired", "rest", "idle", "wait"],
  },
  speech_gap: {
    id: "speech_gap",
    emotionLabel: "speech_gap",
    bodyChannels: ["head_yaw", "head_roll", "gaze_x", "gaze_y"],
    overlayChannels: ["breath"],
    maxOverlays: 1,
    durationMs: [3600, 4800],
    intensityScale: 0.24,
    preferredTags: ["idle", "soft", "pause"],
  },
};

const EXCLUSIVE_CHANNELS = new Set([
  "mouth_smile",
  "mouth_open",
  "mouth_x",
  "eye_open_left",
  "eye_open_right",
  "eye_smile_left",
  "eye_smile_right",
  "brow_bias",
  "brow_left_detail",
  "brow_right_detail",
]);

const DIRECTIONAL_POLARITIES = new Set([
  "positive",
  "negative",
  "open_more",
  "close_more",
  "smile_more",
  "smile_less",
  "cycle",
  "balanced",
]);

export function composeMaterialMotion(
  options: MaterialMotionCompositionOptions,
): MaterialMotionCompositionResult {
  const recipe = MATERIAL_COMPOSITION_RECIPES[options.recipeId];
  const seedText = String(options.seed);
  const baseMetadata: MaterialMotionCompositionMetadata = {
    source: "material_composition",
    recipeId: options.recipeId,
    seed: seedText,
    fragmentIds: [],
    atomIds: [],
    diagnostics: [],
  };
  if (!recipe) {
    return failComposition("composition_recipe_unknown", baseMetadata);
  }

  const catalog = options.model.motion_material_catalog;
  const profile = options.model.semantic_axis_profile;
  if (!catalog || !profile) {
    return failComposition("composition_material_catalog_or_profile_missing", baseMetadata);
  }
  if (
    options.model.name !== profile.model_id
    || catalog.model_id !== profile.model_id
    || catalog.profile_id !== profile.profile_id
    || catalog.profile_revision !== profile.revision
    || catalog.source_hash !== profile.source_hash
  ) {
    return failComposition("composition_material_catalog_identity_mismatch", baseMetadata);
  }

  const axes = buildControllableAxes(profile.axes)
    .filter((axis) => options.allowedAxisIds.includes(axis.id));
  const axisIds = new Set(axes.map((axis) => axis.id));
  const reservedChannels = new Set([
    ...EXCLUSIVE_CHANNELS,
    ...(options.reservedChannels ?? []),
  ]);
  const libraryById = new Map(
    options.model.parameter_action_library.atoms.map((atom) => [atom.id, atom]),
  );
  const random = createSeededRandom(seedToUint32(seedText));
  const fragmentCandidates = catalog.fragments
    .filter((fragment) => isUsableMaterial(fragment.status))
    .filter((fragment) => overlaps(fragment.channels, recipe.bodyChannels))
    .filter((fragment) => fragment.duration_ms >= recipe.durationMs[0] * 0.5)
    .filter((fragment) => fragment.axis_ids.some((axisId) => axisIds.has(axisId)))
    .filter((fragment) => !fragment.channels.some((channel) => reservedChannels.has(channel)))
    .sort((left, right) => compareCandidates(left.id, right.id));
  if (fragmentCandidates.length === 0) {
    return failComposition("composition_no_compatible_fragment", baseMetadata);
  }

  const fragment = chooseFragment(fragmentCandidates, recipe.preferredTags, random);
  const bodyAtoms = resolveAtomsForFragment(catalog, fragment, libraryById, axisIds, reservedChannels);
  if (bodyAtoms.length === 0) {
    return failComposition("composition_fragment_has_no_usable_atoms", {
      ...baseMetadata,
      fragmentIds: [fragment.id],
    });
  }

  const selectedAtoms: ParameterActionAtom[] = [
    ...selectBestAtoms(bodyAtoms, catalog, axisIds),
  ];
  const selectedBodyAtomCount = selectedAtoms.length;
  const usedAxes = new Set(
    catalog.atoms
      .filter((atom) => selectedAtoms.some((selected) => selected.id === atom.id))
      .flatMap((atom) => atom.axis_ids.filter((axisId) => axisIds.has(axisId))),
  );
  const usedParameters = new Set(selectedAtoms.map((atom) => atom.parameter_id));
  const overlayCandidates = catalog.atoms
    .filter((atom) => isUsableMaterial(atom.status))
    .filter((atom) => isDirectionalPolarity(atom.semantic_polarity || atom.polarity))
    .filter((atom) => !selectedAtoms.some((selected) => selected.id === atom.id))
    .filter((atom) => atom.axis_ids.some((axisId) => axisIds.has(axisId)))
    .filter((atom) => overlaps([atom.primary_channel], recipe.overlayChannels))
    .filter((atom) => !atom.primary_channel || !reservedChannels.has(atom.primary_channel))
    .filter((atom) => !atom.axis_ids.some((axisId) =>
      axisIds.has(axisId) && usedAxes.has(axisId)))
    .filter((atom) => !usedParameters.has(atom.parameter_id))
    .sort((left, right) => compareCandidates(left.id, right.id));
  for (const candidate of shuffle(overlayCandidates, random)) {
    if (selectedAtoms.length >= selectedBodyAtomCount + recipe.maxOverlays) {
      break;
    }
    if (candidate.axis_ids.some((axisId) => axisIds.has(axisId) && usedAxes.has(axisId))) {
      continue;
    }
    const libraryAtom = libraryById.get(candidate.id);
    if (!libraryAtom) {
      continue;
    }
    selectedAtoms.push(libraryAtom);
    candidate.axis_ids.forEach((axisId) => usedAxes.add(axisId));
    usedParameters.add(candidate.parameter_id);
  }

  const axisValues = buildAxisValues(selectedAtoms, catalog, axes, recipe.intensityScale);
  if (Object.keys(axisValues).length === 0) {
    return failComposition("composition_no_axis_transition", {
      ...baseMetadata,
      fragmentIds: [fragment.id],
      atomIds: selectedAtoms.map((atom) => atom.id),
    });
  }
  const axisById = new Map(axes.map((axis) => [axis.id, axis]));
  const neutralValues = Object.fromEntries(
    Object.keys(axisValues).map((axisId) => [axisId, axisById.get(axisId)?.neutral ?? 50]),
  );
  const steps: MotionAxisValueStep[] = [
    { axis_values: neutralValues, duration_weight: 1 },
    { axis_values: axisValues, duration_weight: 2 },
    { axis_values: neutralValues, duration_weight: 1 },
  ];
  const durationHintMs = clamp(
    Math.round(fragment.duration_ms || midpoint(recipe.durationMs)),
    recipe.durationMs[0],
    recipe.durationMs[1],
  );
  const metadata: MaterialMotionCompositionMetadata = {
    ...baseMetadata,
    fragmentIds: [fragment.id],
    atomIds: selectedAtoms.map((atom) => atom.id),
    diagnostics: [
      `fragment_status:${fragment.status}`,
      `atom_count:${selectedAtoms.length}`,
      `duration_ms:${durationHintMs}`,
    ],
  };
  return {
    ok: true,
    intent: {
      schema_version: SCHEMA_MOTION_INTENT_V4,
      profile_id: profile.profile_id,
      profile_revision: profile.revision,
      model_id: profile.model_id,
      mode: "idle",
      intent_tags: ["material_composition", recipe.id],
      emotion_label: recipe.emotionLabel,
      duration_hint_ms: durationHintMs,
      motion_steps: steps,
    },
    metadata,
  };
}

function resolveAtomsForFragment(
  catalog: MotionMaterialCatalog,
  fragment: MotionMaterialFragment,
  libraryById: Map<string, ParameterActionAtom>,
  axisIds: Set<string>,
  reservedChannels: Set<string>,
): ParameterActionAtom[] {
  const fragmentParameterIds = new Set(fragment.parameter_ids);
  return catalog.atoms
    .filter((atom) => atom.source_fragment_id === fragment.id)
    .filter((atom) => fragmentParameterIds.has(atom.parameter_id))
    .filter((atom) => isUsableMaterial(atom.status))
    .filter((atom) => isDirectionalPolarity(atom.semantic_polarity || atom.polarity))
    .filter((atom) => atom.axis_ids.some((axisId) => axisIds.has(axisId)))
    .filter((atom) => !atom.primary_channel || !reservedChannels.has(atom.primary_channel))
    .map((atom) => libraryById.get(atom.id))
    .filter((atom): atom is ParameterActionAtom => Boolean(atom));
}

function selectBestAtoms(
  atoms: ParameterActionAtom[],
  catalog: MotionMaterialCatalog,
  axisIds: Set<string>,
): ParameterActionAtom[] {
  const selected: ParameterActionAtom[] = [];
  const usedAxes = new Set<string>();
  for (const atom of [...atoms].sort((left, right) =>
    right.score - left.score || left.id.localeCompare(right.id))) {
    const candidateAxes = axisIdsForLibraryAtom(atom, catalog, axisIds);
    if (candidateAxes.some((axisId) => usedAxes.has(axisId))) {
      continue;
    }
    selected.push(atom);
    candidateAxes.forEach((axisId) => usedAxes.add(axisId));
  }
  return selected;
}

function axisIdsForLibraryAtom(
  atom: ParameterActionAtom,
  catalog: MotionMaterialCatalog,
  axisIds: Set<string>,
): string[] {
  const materialAtom = catalog.atoms.find((candidate) => candidate.id === atom.id);
  return materialAtom?.axis_ids.filter((axisId) => axisIds.has(axisId)) ?? [];
}

function buildAxisValues(
  atoms: ParameterActionAtom[],
  catalog: MotionMaterialCatalog,
  axes: SemanticAxisDefinition[],
  intensityScale: number,
): Record<string, number> {
  const atomById = new Map(catalog.atoms.map((atom) => [atom.id, atom]));
  const axisById = new Map(axes.map((axis) => [axis.id, axis]));
  const values: Record<string, number> = {};
  for (const [index, atom] of atoms.entries()) {
    const materialAtom = atomById.get(atom.id);
    if (!materialAtom) {
      continue;
    }
    const direction = resolveDirection(materialAtom.semantic_polarity || materialAtom.polarity, index);
    if (direction === 0) {
      continue;
    }
    const magnitude = Math.round(strengthToMagnitude(atom.strength) * intensityScale);
    for (const axisId of materialAtom.axis_ids) {
      const axis = axisById.get(axisId);
      if (!axis || values[axisId] !== undefined) {
        continue;
      }
      const target = axis.neutral + direction * magnitude;
      const [softMin, softMax] = axis.soft_range;
      const [valueMin, valueMax] = axis.value_range;
      values[axisId] = clamp(target, Math.max(valueMin, softMin), Math.min(valueMax, softMax));
    }
  }
  return values;
}

function buildControllableAxes(axes: readonly SemanticAxisDefinition[]): SemanticAxisDefinition[] {
  return axes.filter((axis) => ["primary", "hint", "ambient"].includes(axis.control_role));
}

function chooseFragment(
  fragments: MotionMaterialFragment[],
  preferredTags: readonly string[],
  random: () => number,
): MotionMaterialFragment {
  const preferred = fragments.filter((fragment) => overlaps(fragment.tags, preferredTags));
  const pool = preferred.length > 0 ? preferred : fragments;
  return pool[Math.floor(random() * pool.length)] ?? fragments[0];
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function isUsableMaterial(status: string): boolean {
  return status === "ambient_candidate" || status === "compatible";
}

function isDirectionalPolarity(polarity: string): boolean {
  return DIRECTIONAL_POLARITIES.has(polarity);
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function compareCandidates(left: string, right: string): number {
  return left.localeCompare(right);
}

function resolveDirection(polarity: string, index: number): -1 | 0 | 1 {
  if (polarity === "positive" || polarity === "open_more" || polarity === "smile_more") return 1;
  if (polarity === "negative" || polarity === "close_more" || polarity === "smile_less") return -1;
  if (polarity === "cycle" || polarity === "balanced") return index % 2 === 0 ? 1 : -1;
  return 0;
}

function strengthToMagnitude(strength: string): number {
  switch (strength) {
    case "low":
      return 9;
    case "medium":
      return 16;
    case "high":
      return 22;
    default:
      return 6;
  }
}

function midpoint(range: readonly [number, number]): number {
  return (range[0] + range[1]) / 2;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function seedToUint32(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
}

function failComposition(
  reason: string,
  metadata: MaterialMotionCompositionMetadata,
): MaterialMotionCompositionResult {
  return {
    ok: false,
    reason,
    metadata: {
      ...metadata,
      diagnostics: [...metadata.diagnostics, reason],
    },
  };
}
