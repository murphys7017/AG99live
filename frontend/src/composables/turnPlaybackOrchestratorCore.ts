// Orchestrator startup window: once text/audio are present, keep a wider window
// for a late motion plan to join the same playback group before releasing.
export const AUDIO_MOTION_SYNC_WAIT_MS = 820;
export const TEXT_ONLY_RELEASE_WAIT_MS = 260;

export interface PendingTurnPlaybackGroup {
  key: string;
  ephemeral: boolean;
  turnId: string | null;
  orchestrationId: string | null;
  firstReadyAtMs: number;
  textReady: boolean;
  audioReady: boolean;
  noAudioConfirmed: boolean;
  motionReady: boolean;
  motionPayload: unknown | null;
  motionReceivedAtMs: number;
  textReleased: boolean;
  released: boolean;
  releaseTimer: unknown | null;
}

export interface TurnPlaybackReleaseContext {
  turnId: string | null;
  orchestrationId: string | null;
  receivedAtMs: number;
}

export interface TurnPlaybackOrchestratorCoreOptions {
  now: () => number;
  schedule: (delayMs: number, fn: () => void) => unknown;
  clearSchedule: (timer: unknown) => void;
  releaseText: (turnId: string | null, orchestrationId: string | null) => boolean;
  releaseAudio: (turnId: string | null, orchestrationId: string | null) => void;
  releaseMotion: (payload: unknown, context: TurnPlaybackReleaseContext) => void;
  log?: (message: string, details: Record<string, unknown>) => void;
  createEphemeralGroupKey?: () => string;
}

function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveTurnPlaybackGroupKey(
  turnId: string | null,
  orchestrationId: string | null,
): string {
  const normalizedOrchestrationId = normalizeId(orchestrationId);
  if (normalizedOrchestrationId) {
    return `orch:${normalizedOrchestrationId}`;
  }
  const normalizedTurnId = normalizeId(turnId);
  if (normalizedTurnId) {
    return `turn:${normalizedTurnId}`;
  }
  return "";
}

export function createTurnPlaybackOrchestratorCore(
  options: TurnPlaybackOrchestratorCoreOptions,
) {
  const groups = new Map<string, PendingTurnPlaybackGroup>();
  let ephemeralGroupSerial = 0;

  function log(message: string, details: Record<string, unknown>): void {
    options.log?.(message, details);
  }

  function createEphemeralGroupKey(): string {
    if (options.createEphemeralGroupKey) {
      return options.createEphemeralGroupKey();
    }
    ephemeralGroupSerial += 1;
    return `ephemeral:${ephemeralGroupSerial}`;
  }

  function getOrCreateGroup(
    turnId: string | null,
    orchestrationId: string | null,
  ): PendingTurnPlaybackGroup {
    const resolvedKey = resolveTurnPlaybackGroupKey(turnId, orchestrationId);
    if (resolvedKey) {
      const existing = groups.get(resolvedKey);
      if (existing) {
        existing.turnId = existing.turnId ?? turnId;
        existing.orchestrationId = existing.orchestrationId ?? orchestrationId;
        return existing;
      }
    }

    const ephemeral = !resolvedKey;
    const key = resolvedKey || createEphemeralGroupKey();
    const group: PendingTurnPlaybackGroup = {
      key,
      ephemeral,
      turnId,
      orchestrationId,
      firstReadyAtMs: options.now(),
      textReady: false,
      audioReady: false,
      noAudioConfirmed: false,
      motionReady: false,
      motionPayload: null,
      motionReceivedAtMs: 0,
      textReleased: false,
      released: false,
      releaseTimer: null,
    };
    groups.set(key, group);
    return group;
  }

  function deleteGroup(group: PendingTurnPlaybackGroup): void {
    groups.delete(group.key);
  }

  function clearReleaseTimer(group: PendingTurnPlaybackGroup): void {
    if (group.releaseTimer !== null) {
      options.clearSchedule(group.releaseTimer);
      group.releaseTimer = null;
    }
  }

  function scheduleEvaluate(
    group: PendingTurnPlaybackGroup,
    delayMs: number,
  ): void {
    clearReleaseTimer(group);
    group.releaseTimer = options.schedule(Math.max(0, Math.round(delayMs)), () => {
      group.releaseTimer = null;
      evaluateGroup(group, "timer");
    });
  }

  function releaseMotion(group: PendingTurnPlaybackGroup, reason: string): void {
    if (!group.motionReady || group.motionPayload === null) {
      return;
    }
    const payload = group.motionPayload;
    group.motionPayload = null;
    group.motionReady = false;
    options.releaseMotion(payload, {
      turnId: group.turnId,
      orchestrationId: group.orchestrationId,
      receivedAtMs: group.motionReceivedAtMs || options.now(),
    });
    log("motion released", {
      turnId: group.turnId,
      orchestrationId: group.orchestrationId,
      reason,
    });
  }

  function releaseGroup(group: PendingTurnPlaybackGroup, reason: string): void {
    clearReleaseTimer(group);
    group.released = true;
    const releasedText = options.releaseText(
      group.turnId,
      group.orchestrationId,
    );
    group.textReleased = group.textReleased || releasedText;
    releaseMotion(group, reason);
    if (group.audioReady) {
      options.releaseAudio(group.turnId, group.orchestrationId);
    }
    log("group released", {
      turnId: group.turnId,
      orchestrationId: group.orchestrationId,
      reason,
      releasedText,
      audioReady: group.audioReady,
      noAudioConfirmed: group.noAudioConfirmed,
    });
    if (group.ephemeral) {
      deleteGroup(group);
    }
  }

  function releaseTextOnly(group: PendingTurnPlaybackGroup, reason: string): void {
    if (group.textReleased) {
      return;
    }
    const releasedText = options.releaseText(
      group.turnId,
      group.orchestrationId,
    );
    group.textReleased = group.textReleased || releasedText;
    log("text released before audio", {
      turnId: group.turnId,
      orchestrationId: group.orchestrationId,
      reason,
      releasedText,
    });
  }

  function evaluateGroup(
    group: PendingTurnPlaybackGroup,
    reason: string,
  ): void {
    if (group.released) {
      if (group.motionReady) {
        releaseMotion(group, `late_motion_after_${reason}`);
      }
      if (group.ephemeral) {
        deleteGroup(group);
      }
      return;
    }

    if (!group.textReady) {
      return;
    }

    if (group.audioReady && group.motionReady) {
      releaseGroup(group, `text_audio_motion_ready:${reason}`);
      return;
    }

    if (group.audioReady) {
      const elapsedMs = options.now() - group.firstReadyAtMs;
      if (elapsedMs >= AUDIO_MOTION_SYNC_WAIT_MS) {
        releaseGroup(group, `audio_motion_wait_elapsed:${reason}`);
        return;
      }
      scheduleEvaluate(group, AUDIO_MOTION_SYNC_WAIT_MS - elapsedMs);
      return;
    }

    if (group.noAudioConfirmed && group.motionReady) {
      releaseGroup(group, `text_motion_no_audio:${reason}`);
      return;
    }

    if (group.noAudioConfirmed) {
      releaseGroup(group, `text_only_no_audio:${reason}`);
      return;
    }

    const elapsedMs = options.now() - group.firstReadyAtMs;
    if (elapsedMs >= TEXT_ONLY_RELEASE_WAIT_MS) {
      releaseTextOnly(group, `text_wait_elapsed:${reason}`);
      return;
    }
    scheduleEvaluate(group, TEXT_ONLY_RELEASE_WAIT_MS - elapsedMs);
  }

  function clearGroups(): void {
    for (const group of groups.values()) {
      clearReleaseTimer(group);
    }
    groups.clear();
  }

  return {
    markTextReady: (turnId: string | null, orchestrationId: string | null) => {
      const group = getOrCreateGroup(turnId, orchestrationId);
      group.textReady = true;
      evaluateGroup(group, "text_ready");
    },
    markAudioReady: (turnId: string | null, orchestrationId: string | null) => {
      const group = getOrCreateGroup(turnId, orchestrationId);
      group.audioReady = true;
      evaluateGroup(group, "audio_ready");
    },
    markMotionReady: (
      turnId: string | null,
      orchestrationId: string | null,
      payload: unknown,
      receivedAtMs: number,
    ) => {
      if (!payload) {
        return;
      }
      const group = getOrCreateGroup(turnId, orchestrationId);
      group.motionReady = true;
      group.motionPayload = payload;
      group.motionReceivedAtMs = receivedAtMs;
      evaluateGroup(group, "motion_ready");
    },
    markNoAudioConfirmed: (
      turnId: string | null,
      orchestrationId: string | null,
    ) => {
      const group = getOrCreateGroup(turnId, orchestrationId);
      group.noAudioConfirmed = true;
      evaluateGroup(group, "no_audio_terminal");
    },
    markTurnFinished: (
      turnId: string | null,
      orchestrationId: string | null,
    ) => {
      const group = getOrCreateGroup(turnId, orchestrationId);
      group.noAudioConfirmed = group.noAudioConfirmed || !group.audioReady;
      evaluateGroup(group, "turn_finished");
    },
    flush: () => {
      for (const group of groups.values()) {
        evaluateGroup(group, "manual_flush");
      }
    },
    clear: clearGroups,
    getGroupCount: () => groups.size,
  };
}
