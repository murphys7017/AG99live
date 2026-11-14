import type { NormalizedMotionPayload } from "../../types/motion.js";

export type AmbientActionSource = "local" | "material_composition" | "model_passive";

export interface AmbientActionContext {
  connectionReady: boolean;
  modelReady: boolean;
  ambientMotionEnabled: boolean;
  audioPlaying: boolean;
  microphoneCapturing: boolean;
  conversationActive: boolean;
  manualPreviewActive: boolean;
}

export interface AmbientActionCandidate {
  id: string;
  source: AmbientActionSource;
  motion: NormalizedMotionPayload;
  expiresAt: number;
}

export type AmbientActionRejectionReason =
  | "ambient_action_id_missing"
  | "ambient_action_expired"
  | "ambient_action_kind_invalid"
  | "ambient_action_resource_forbidden"
  | "ambient_action_steps_invalid"
  | "ambient_action_disconnected"
  | "ambient_action_model_unavailable"
  | "ambient_action_disabled"
  | "ambient_action_audio_active"
  | "ambient_action_microphone_active"
  | "ambient_action_conversation_active"
  | "ambient_action_manual_preview_active"
  | "ambient_action_already_active"
  | "ambient_action_start_failed";

export type AmbientActionDecision =
  | {
    accepted: true;
    candidateId: string;
    source: AmbientActionSource;
  }
  | {
    accepted: false;
    candidateId: string;
    source: AmbientActionSource;
    reason: AmbientActionRejectionReason;
  };

export interface AmbientActionDirectorDependencies {
  getContext: () => AmbientActionContext;
  start: (candidate: AmbientActionCandidate) => boolean;
  stop: (reason: string) => void;
  now?: () => number;
  onDecision?: (decision: AmbientActionDecision) => void;
}

export interface AmbientActionDirector {
  admit(candidate: AmbientActionCandidate): AmbientActionDecision;
  reconcile(): void;
  cancel(reason: string): void;
  getActiveCandidate(): Readonly<AmbientActionCandidate> | null;
  dispose(): void;
}

interface ActiveAmbientAction {
  candidate: AmbientActionCandidate;
  releaseAt: number;
}

const AMBIENT_ACTION_MIN_DURATION_MS = 300;
const AMBIENT_ACTION_DEFAULT_DURATION_MS = 3_000;
const AMBIENT_ACTION_MAX_DURATION_MS = 10_000;
const AMBIENT_ACTION_RELEASE_GRACE_MS = 750;

export function createAmbientActionDirector(
  dependencies: AmbientActionDirectorDependencies,
): AmbientActionDirector {
  const now = dependencies.now ?? (() => Date.now());
  let active: ActiveAmbientAction | null = null;
  let lastContextAdmissible: boolean | null = null;
  let disposed = false;

  function emit(decision: AmbientActionDecision): AmbientActionDecision {
    try {
      dependencies.onDecision?.(decision);
    } catch (error) {
      console.warn("[AmbientActionDirector] decision observer failed.", error);
    }
    return decision;
  }

  function reject(
    candidate: AmbientActionCandidate,
    reason: AmbientActionRejectionReason,
  ): AmbientActionDecision {
    return emit({
      accepted: false,
      candidateId: candidate.id.trim(),
      source: candidate.source,
      reason,
    });
  }

  function reconcile(): void {
    if (disposed) {
      return;
    }

    const contextAdmissible = isContextAdmissible(dependencies.getContext());
    if (!contextAdmissible) {
      if (active || lastContextAdmissible !== false) {
        dependencies.stop("ambient_context_changed");
      }
      active = null;
      lastContextAdmissible = false;
      return;
    }

    lastContextAdmissible = true;
    if (!active) {
      return;
    }

    if (now() >= active.releaseAt) {
      active = null;
    }
  }

  function admit(candidate: AmbientActionCandidate): AmbientActionDecision {
    if (disposed) {
      return reject(candidate, "ambient_action_start_failed");
    }

    reconcile();
    const candidateId = candidate.id.trim();
    if (!candidateId) {
      return reject(candidate, "ambient_action_id_missing");
    }
    const currentTime = now();
    if (!Number.isFinite(candidate.expiresAt) || candidate.expiresAt <= currentTime) {
      return reject(candidate, "ambient_action_expired");
    }
    if (candidate.motion.kind !== "semantic_intent") {
      return reject(candidate, "ambient_action_kind_invalid");
    }
    const intent = candidate.motion.intent;
    if (intent.motion_resource_id || intent.expression_resource_id) {
      return reject(candidate, "ambient_action_resource_forbidden");
    }
    if (!intent.motion_steps || intent.motion_steps.length < 1 || intent.motion_steps.length > 4) {
      return reject(candidate, "ambient_action_steps_invalid");
    }
    if (active) {
      return reject(candidate, "ambient_action_already_active");
    }

    const contextReason = getContextRejectionReason(dependencies.getContext());
    if (contextReason) {
      return reject(candidate, contextReason);
    }
    lastContextAdmissible = true;

    const normalizedCandidate: AmbientActionCandidate = {
      ...candidate,
      id: candidateId,
    };
    if (!dependencies.start(normalizedCandidate)) {
      return reject(normalizedCandidate, "ambient_action_start_failed");
    }

    const durationMs = clampDuration(intent.duration_hint_ms);
    active = {
      candidate: normalizedCandidate,
      releaseAt: now() + durationMs + AMBIENT_ACTION_RELEASE_GRACE_MS,
    };
    return emit({
      accepted: true,
      candidateId,
      source: candidate.source,
    });
  }

  function cancel(reason: string): void {
    if (disposed) {
      return;
    }
    active = null;
    lastContextAdmissible = null;
    dependencies.stop(reason);
  }

  function getActiveCandidate(): Readonly<AmbientActionCandidate> | null {
    return active?.candidate ?? null;
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    cancel("ambient_director_disposed");
    disposed = true;
  }

  return {
    admit,
    reconcile,
    cancel,
    getActiveCandidate,
    dispose,
  };
}

function isContextAdmissible(context: AmbientActionContext): boolean {
  return getContextRejectionReason(context) === null;
}

function getContextRejectionReason(
  context: AmbientActionContext,
): AmbientActionRejectionReason | null {
  if (!context.connectionReady) {
    return "ambient_action_disconnected";
  }
  if (!context.modelReady) {
    return "ambient_action_model_unavailable";
  }
  if (!context.ambientMotionEnabled) {
    return "ambient_action_disabled";
  }
  if (context.audioPlaying) {
    return "ambient_action_audio_active";
  }
  if (context.microphoneCapturing) {
    return "ambient_action_microphone_active";
  }
  if (context.conversationActive) {
    return "ambient_action_conversation_active";
  }
  if (context.manualPreviewActive) {
    return "ambient_action_manual_preview_active";
  }
  return null;
}

function clampDuration(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return AMBIENT_ACTION_DEFAULT_DURATION_MS;
  }
  return Math.max(
    AMBIENT_ACTION_MIN_DURATION_MS,
    Math.min(AMBIENT_ACTION_MAX_DURATION_MS, Math.round(value)),
  );
}
