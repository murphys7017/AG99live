import {
  SCHEMA_MOTION_INTENT_V4,
  type ModelSummary,
  type MotionAxisValueStep,
  type NormalizedSemanticMotionIntent,
} from "../../types/protocol.js";
import type { SemanticAxisDefinition } from "../../types/semantic-axis-profile.js";
import {
  MATERIAL_COMPOSITION_RECIPES,
  composeMaterialMotion,
  type MaterialCompositionRecipeId,
} from "../composer/materialMotionComposer.js";
import {
  isAmbientActionContextAdmissible,
  type AmbientActionCandidate,
  type AmbientActionContext,
  type AmbientActionDirector,
} from "./ambientActionDirector.js";
import {
  REACTION_ACTION_CATALOG,
  type ReactionActionTemplate,
} from "./reactionActionCatalog.js";

type AmbientScheduleHandle = ReturnType<typeof setTimeout>;

export interface AmbientActionSchedulerDependencies {
  getContext: () => AmbientActionContext;
  getModel: () => ModelSummary | null;
  director: Pick<AmbientActionDirector, "admit" | "reconcile">;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => AmbientScheduleHandle;
  cancelSchedule?: (handle: AmbientScheduleHandle) => void;
}

export interface AmbientActionScheduler {
  start(): void;
  nudge(): void;
  dispose(): void;
}

const LOCAL_ACTION_TEMPLATES: readonly ReactionActionTemplate[] =
  REACTION_ACTION_CATALOG.filter((template) =>
    template.triggers.includes("idle") || template.triggers.includes("waiting"));

const MATERIAL_RECIPE_IDS = Object.keys(
  MATERIAL_COMPOSITION_RECIPES,
) as MaterialCompositionRecipeId[];

const INITIAL_DELAY_MS = 1_500;
const NUDGE_DELAY_MS = 250;
const BLOCKED_RETRY_MS = 2_500;
const ACTIVE_RETRY_MS = 1_000;
const FAILED_RETRY_MS = 3_500;
const ACTION_GAP_MS = 1_800;
const LOCAL_MIN_INTERVAL_MS = 5_000;
const MATERIAL_COOLDOWN_MS = 30_000;
const MATERIAL_EVERY_ACCEPTED_ACTIONS = 3;

export function createAmbientActionScheduler(
  dependencies: AmbientActionSchedulerDependencies,
): AmbientActionScheduler {
  const now = dependencies.now ?? (() => Date.now());
  const schedule = dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = dependencies.cancelSchedule ?? ((handle) => clearTimeout(handle));
  let running = false;
  let disposed = false;
  let scheduledHandle: AmbientScheduleHandle | null = null;
  let scheduledDueAt = 0;
  let actionSequence = 0;
  let acceptedActionCount = 0;
  let lastMaterialAttemptAt = Number.NEGATIVE_INFINITY;
  let lastMaterialRecipe: MaterialCompositionRecipeId | null = null;
  let modelIdentity = "";

  function clearScheduledAttempt(): void {
    if (scheduledHandle === null) {
      return;
    }
    cancelSchedule(scheduledHandle);
    scheduledHandle = null;
    scheduledDueAt = 0;
  }

  function scheduleAfter(delayMs: number): void {
    if (!running || disposed) {
      return;
    }
    const dueAt = now() + Math.max(0, Math.round(delayMs));
    if (scheduledHandle !== null && scheduledDueAt <= dueAt) {
      return;
    }
    clearScheduledAttempt();
    scheduledDueAt = dueAt;
    scheduledHandle = schedule(() => {
      scheduledHandle = null;
      scheduledDueAt = 0;
      attemptAction();
    }, Math.max(0, dueAt - now()));
  }

  function start(): void {
    if (disposed || running) {
      return;
    }
    running = true;
    console.info("[AmbientActionScheduler] started.");
    scheduleAfter(INITIAL_DELAY_MS);
  }

  function nudge(): void {
    if (!running || disposed) {
      return;
    }
    scheduleAfter(NUDGE_DELAY_MS);
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    running = false;
    clearScheduledAttempt();
    disposed = true;
  }

  function attemptAction(): void {
    if (!running || disposed) {
      return;
    }
    dependencies.director.reconcile();
    if (!isAmbientActionContextAdmissible(dependencies.getContext())) {
      scheduleAfter(BLOCKED_RETRY_MS);
      return;
    }

    const model = dependencies.getModel();
    if (!model) {
      scheduleAfter(BLOCKED_RETRY_MS);
      return;
    }

    const currentModelIdentity = [
      model.name,
      model.semantic_axis_profile?.profile_id ?? "",
      model.semantic_axis_profile?.revision ?? 0,
      model.semantic_axis_profile?.source_hash ?? "",
    ].join(":");
    if (currentModelIdentity !== modelIdentity) {
      modelIdentity = currentModelIdentity;
      actionSequence = 0;
      acceptedActionCount = 0;
      lastMaterialAttemptAt = Number.NEGATIVE_INFINITY;
      lastMaterialRecipe = null;
    }

    const currentTime = now();
    const sequence = ++actionSequence;
    const materialCandidate = shouldUseMaterial(model, currentTime)
      ? createMaterialCandidate(model, currentTime, sequence)
      : null;
    const candidate = materialCandidate ?? createLocalCandidate(model, currentTime, sequence);
    if (!candidate) {
      scheduleAfter(FAILED_RETRY_MS);
      return;
    }

    const decision = dependencies.director.admit(candidate);
    if (decision.accepted) {
      console.info("[AmbientActionScheduler] idle action admitted.", {
        candidateId: candidate.id,
        source: candidate.source,
        durationMs: candidate.motion.kind === "semantic_intent"
          ? candidate.motion.intent.duration_hint_ms ?? null
          : null,
      });
      recordAccepted(candidate);
      scheduleAfter(getNextAttemptDelay(candidate));
      return;
    }

    if (candidate.source === "material_composition"
      && decision.reason === "ambient_action_start_failed") {
      const fallbackSequence = ++actionSequence;
      const fallback = createLocalCandidate(model, currentTime, fallbackSequence);
      if (fallback) {
        const fallbackDecision = dependencies.director.admit(fallback);
        if (fallbackDecision.accepted) {
          recordAccepted(fallback);
          scheduleAfter(getNextAttemptDelay(fallback));
          return;
        }
      }
    }
    scheduleAfter(decision.reason === "ambient_action_already_active"
      ? ACTIVE_RETRY_MS
      : FAILED_RETRY_MS);
  }

  function shouldUseMaterial(model: ModelSummary, currentTime: number): boolean {
    const catalog = model.motion_material_catalog;
    if (
      !catalog
      || catalog.summary.ambient_fragment_count < 1
      || catalog.summary.ambient_atom_count < 1
    ) {
      return false;
    }
    if (currentTime - lastMaterialAttemptAt < MATERIAL_COOLDOWN_MS) {
      return false;
    }
    return acceptedActionCount > 0
      && acceptedActionCount % MATERIAL_EVERY_ACCEPTED_ACTIONS === 0;
  }

  function createMaterialCandidate(
    model: ModelSummary,
    currentTime: number,
    sequence: number,
  ): AmbientActionCandidate | null {
    if (MATERIAL_RECIPE_IDS.length === 0) {
      return null;
    }
    const recipeId = selectMaterialRecipe(sequence);
    lastMaterialAttemptAt = currentTime;
    const result = composeMaterialMotion({
      model,
      recipeId,
      seed: `ambient-material:${model.name}:${sequence}`,
    });
    if (!result.ok) {
      console.debug("[AmbientActionScheduler] material composition unavailable.", {
        recipeId,
        reason: result.reason,
      });
      return null;
    }
    return {
      id: `ambient:material_composition:${sequence}`,
      source: "material_composition",
      motion: {
        kind: "semantic_intent",
        intent: result.intent,
      },
      expiresAt: currentTime + getCandidateLifetime(result.intent),
      metadata: {
        recipeId: result.metadata.recipeId,
        seed: result.metadata.seed,
        fragmentIds: [...result.metadata.fragmentIds],
        atomIds: [...result.metadata.atomIds],
        diagnostics: [...result.metadata.diagnostics],
      },
    };
  }

  function createLocalCandidate(
    model: ModelSummary,
    currentTime: number,
    sequence: number,
  ): AmbientActionCandidate | null {
    const profile = model.semantic_axis_profile;
    if (!profile) {
      return null;
    }
    const template = LOCAL_ACTION_TEMPLATES[sequence % LOCAL_ACTION_TEMPLATES.length];
    const axes = selectLocalAxes(profile.axes, template, sequence);
    if (axes.length === 0) {
      return null;
    }
    const targetValues: Record<string, number> = {};
    const neutralValues: Record<string, number> = {};
    for (const [index, axis] of axes.entries()) {
      const direction = (sequence + index) % 2 === 0 ? 1 : -1;
      const target = buildTargetValue(axis, direction, template.intensityScale);
      if (target === null || target === axis.neutral) {
        continue;
      }
      targetValues[axis.id] = target;
      neutralValues[axis.id] = axis.neutral;
    }
    if (Object.keys(targetValues).length === 0) {
      return null;
    }

    const durationHintMs = template.durationMs + (sequence % 3) * 150;
    const intent: Extract<
      NormalizedSemanticMotionIntent,
      { motion_steps: MotionAxisValueStep[] }
    > = {
      schema_version: SCHEMA_MOTION_INTENT_V4,
      profile_id: profile.profile_id,
      profile_revision: profile.revision,
      model_id: profile.model_id,
      mode: "idle",
      intent_tags: ["ambient", "local", template.id],
      emotion_label: template.emotionLabel,
      duration_hint_ms: durationHintMs,
      motion_steps: [
        { axis_values: neutralValues, duration_weight: 1 },
        { axis_values: targetValues, duration_weight: 2 },
        { axis_values: neutralValues, duration_weight: 1 },
      ],
    };
    return {
      id: `ambient:local:${template.id}:${sequence}`,
      source: "local",
      motion: { kind: "semantic_intent", intent },
      expiresAt: currentTime + getCandidateLifetime(intent),
      metadata: {
        templateId: template.id,
        diagnostics: [
          `axis_count:${Object.keys(targetValues).length}`,
          `duration_ms:${durationHintMs}`,
        ],
      },
    };
  }

  function recordAccepted(candidate: AmbientActionCandidate): void {
    acceptedActionCount += 1;
    if (candidate.source === "material_composition") {
      const recipeTag = candidate.motion.kind === "semantic_intent"
        ? candidate.motion.intent.intent_tags?.find((tag) => tag in MATERIAL_COMPOSITION_RECIPES)
        : undefined;
      lastMaterialRecipe = (recipeTag as MaterialCompositionRecipeId | undefined) ?? null;
    }
  }

  function selectMaterialRecipe(sequence: number): MaterialCompositionRecipeId {
    const offset = sequence % MATERIAL_RECIPE_IDS.length;
    const selected = MATERIAL_RECIPE_IDS[offset];
    if (selected !== lastMaterialRecipe || MATERIAL_RECIPE_IDS.length === 1) {
      return selected;
    }
    return MATERIAL_RECIPE_IDS[(offset + 1) % MATERIAL_RECIPE_IDS.length];
  }

  function getNextAttemptDelay(candidate: AmbientActionCandidate): number {
    const duration = candidate.motion.kind === "semantic_intent"
      ? candidate.motion.intent.duration_hint_ms ?? 1_800
      : 1_800;
    return Math.max(LOCAL_MIN_INTERVAL_MS, Math.round(duration) + ACTION_GAP_MS);
  }

  return { start, nudge, dispose };
}

function selectLocalAxes(
  axes: readonly SemanticAxisDefinition[],
  template: ReactionActionTemplate,
  sequence: number,
): SemanticAxisDefinition[] {
  const usable = axes
    .filter((axis) => axis.control_role === "primary"
      || axis.control_role === "hint"
      || axis.control_role === "ambient")
    .filter((axis) => axis.parameter_bindings.length > 0)
    .filter((axis) => template.semanticGroups.includes(axis.semantic_group))
    .sort((left, right) => left.id.localeCompare(right.id));
  const hinted = usable.filter((axis) => matchesAxisHint(axis, template.axisHints));
  const pool = hinted.length > 0 ? hinted : usable;
  const selected: SemanticAxisDefinition[] = [];
  for (let index = 0; index < template.axisCount && pool.length > 0; index += 1) {
    const axis = pool[(sequence + index) % pool.length];
    if (!selected.some((item) => item.id === axis.id)) {
      selected.push(axis);
    }
  }
  return selected;
}

function matchesAxisHint(axis: SemanticAxisDefinition, hints: readonly string[]): boolean {
  const searchable = `${axis.id} ${axis.label} ${axis.semantic_group}`.toLowerCase();
  return hints.some((hint) => searchable.includes(hint));
}

function buildTargetValue(
  axis: SemanticAxisDefinition,
  direction: 1 | -1,
  intensityScale: number,
): number | null {
  const lower = Math.max(axis.value_range[0], axis.soft_range[0]);
  const upper = Math.min(axis.value_range[1], axis.soft_range[1]);
  const room = direction > 0 ? upper - axis.neutral : axis.neutral - lower;
  if (!Number.isFinite(room) || room <= 0) {
    return null;
  }
  const delta = Math.max(1, Math.round(room * intensityScale));
  const target = axis.neutral + direction * delta;
  return Math.min(upper, Math.max(lower, target));
}

function getCandidateLifetime(intent: NormalizedSemanticMotionIntent): number {
  const duration = intent.duration_hint_ms;
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    return 6_000;
  }
  return Math.max(2_000, Math.round(duration) + 3_000);
}
