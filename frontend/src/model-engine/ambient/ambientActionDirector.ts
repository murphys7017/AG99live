import type { NormalizedMotionPayload } from "../../types/motion.js";
import { MAX_IDLE_MOTION_STEPS } from "../constants.js";

export type AmbientActionSource = "local" | "material_composition" | "model_passive";

export interface AmbientActionContext {
  connectionReady: boolean;
  modelReady: boolean;
  ambientMotionEnabled: boolean;
  audioPlaying: boolean;
  microphoneCapturing: boolean;
  conversationPreparing: boolean;
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
  | "ambient_action_conversation_preparing"
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
  start: (candidate: AmbientActionCandidate) => { durationMs: number } | null;
  release: (candidateId: string, reason: string) => void;
  now?: () => number;
  onDecision?: (decision: AmbientActionDecision) => void;
}

export interface AmbientActionDirector {
  admit(candidate: AmbientActionCandidate): AmbientActionDecision;
  reconcile(): void;
  releaseAll(reason: string): void;
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
// Keep the contribution graph bounded while allowing one active plan per source.
const MAX_ACTIVE_AMBIENT_ACTIONS = 3;

export function createAmbientActionDirector(
  dependencies: AmbientActionDirectorDependencies,
): AmbientActionDirector {
  const now = dependencies.now ?? (() => Date.now());
  const active = new Map<string, ActiveAmbientAction>();
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

  function releaseAll(reason: string): void {
    const candidateIds = [...active.keys()];
    active.clear();
    for (const candidateId of candidateIds) {
      try {
        dependencies.release(candidateId, reason);
      } catch (error) {
        console.warn("[AmbientActionDirector] release observer failed.", {
          candidateId,
          reason,
          error,
        });
      }
    }
  }

  function reconcile(): void {
    if (disposed) {
      return;
    }

    const context = dependencies.getContext();
    const contextReason = getContextRejectionReason(context);
    // Conversation, audio, microphone, and preview states block new plans but
    // leave existing contributions available for priority mixing and natural release.
    if (shouldReleaseForContext(contextReason) && active.size > 0) {
      releaseAll("ambient_context_changed");
    }
    const currentTime = now();
    for (const [candidateId, entry] of active) {
      if (currentTime < entry.releaseAt) {
        continue;
      }
      active.delete(candidateId);
      try {
        dependencies.release(candidateId, "ambient_action_completed");
      } catch (error) {
        console.warn("[AmbientActionDirector] completion release failed.", {
          candidateId,
          error,
        });
      }
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
    if (
      !intent.motion_steps
      || intent.motion_steps.length < 1
      || intent.motion_steps.length > MAX_IDLE_MOTION_STEPS
    ) {
      return reject(candidate, "ambient_action_steps_invalid");
    }

    const contextReason = getContextRejectionReason(dependencies.getContext());
    if (contextReason) {
      return reject(candidate, contextReason);
    }

    if (
      active.has(candidateId)
      || active.size >= MAX_ACTIVE_AMBIENT_ACTIONS
      || [...active.values()].some((entry) => entry.candidate.source === candidate.source)
    ) {
      return reject(candidate, "ambient_action_already_active");
    }

    const normalizedCandidate: AmbientActionCandidate = {
      ...candidate,
      id: candidateId,
    };
    let started: { durationMs: number } | null = null;
    try {
      started = dependencies.start(normalizedCandidate);
    } catch (error) {
      console.warn("[AmbientActionDirector] candidate start failed.", {
        candidateId,
        source: candidate.source,
        error,
      });
    }
    if (!started || !Number.isFinite(started.durationMs) || started.durationMs <= 0) {
      return reject(normalizedCandidate, "ambient_action_start_failed");
    }

    const durationMs = clampDuration(started.durationMs);
    active.set(candidateId, {
      candidate: normalizedCandidate,
      releaseAt: now() + durationMs + AMBIENT_ACTION_RELEASE_GRACE_MS,
    });
    return emit({
      accepted: true,
      candidateId,
      source: candidate.source,
    });
  }

  function releaseAllActiveActions(reason: string): void {
    if (disposed) {
      return;
    }
    releaseAll(reason);
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    releaseAllActiveActions("ambient_director_disposed");
    disposed = true;
  }

  return {
    admit,
    reconcile,
    releaseAll: releaseAllActiveActions,
    dispose,
  };
}

function isContextAdmissible(context: AmbientActionContext): boolean {
  return getContextRejectionReason(context) === null;
}

function shouldReleaseForContext(
  reason: AmbientActionRejectionReason | null,
): boolean {
  return reason === "ambient_action_disconnected"
    || reason === "ambient_action_model_unavailable"
    || reason === "ambient_action_disabled";
}

export function isAmbientActionContextAdmissible(context: AmbientActionContext): boolean {
  return isContextAdmissible(context);
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
  if (context.conversationPreparing) {
    return "ambient_action_conversation_preparing";
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
