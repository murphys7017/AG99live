// Orchestrator startup window: once text/audio are present, keep a wider window
// for a late motion plan to join the same playback group before releasing.
export const AUDIO_MOTION_SYNC_WAIT_MS = 820;
export const TEXT_ONLY_RELEASE_WAIT_MS = 260;

export interface PendingTurnPlaybackGroup {
  key: string;
  messageId: string;
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
  messageId: string;
  turnId: string | null;
  orchestrationId: string | null;
  receivedAtMs: number;
}

export interface TurnPlaybackOrchestratorCoreOptions {
  now: () => number;
  schedule: (delayMs: number, fn: () => void) => unknown;
  clearSchedule: (timer: unknown) => void;
  releaseText: (
    messageId: string,
    turnId: string | null,
    orchestrationId: string | null,
  ) => boolean;
  releaseAudio: (
    messageId: string,
    turnId: string | null,
    orchestrationId: string | null,
  ) => void;
  releaseMotion: (payload: unknown, context: TurnPlaybackReleaseContext) => void;
  log?: (message: string, details: Record<string, unknown>) => void;
}

export function resolveTurnPlaybackGroupKey(
  messageId: string,
): string {
  const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
  if (!normalizedMessageId) {
    throw new Error("Turn playback group requires a non-empty messageId.");
  }
  return `segment:${normalizedMessageId}`;
}

export function createTurnPlaybackOrchestratorCore(
  options: TurnPlaybackOrchestratorCoreOptions,
) {
  const groups = new Map<string, PendingTurnPlaybackGroup>();

  function log(message: string, details: Record<string, unknown>): void {
    options.log?.(message, details);
  }

  function getOrCreateGroup(
    messageId: string,
    turnId: string | null,
    orchestrationId: string | null,
  ): PendingTurnPlaybackGroup {
    const key = resolveTurnPlaybackGroupKey(messageId);
    const existing = groups.get(key);
    if (existing) {
      existing.turnId = existing.turnId ?? turnId;
      existing.orchestrationId = existing.orchestrationId ?? orchestrationId;
      return existing;
    }

    const group: PendingTurnPlaybackGroup = {
      key,
      messageId,
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
      messageId: group.messageId,
    });
    log("motion released", {
      messageId: group.messageId,
      turnId: group.turnId,
      orchestrationId: group.orchestrationId,
      reason,
    });
  }

  function releaseGroup(group: PendingTurnPlaybackGroup, reason: string): void {
    clearReleaseTimer(group);
    group.released = true;
    const releasedText = options.releaseText(
      group.messageId,
      group.turnId,
      group.orchestrationId,
    );
    group.textReleased = group.textReleased || releasedText;
    releaseMotion(group, reason);
    if (group.audioReady) {
      options.releaseAudio(group.messageId, group.turnId, group.orchestrationId);
      group.audioReady = false;
    }
    log("group released", {
      messageId: group.messageId,
      turnId: group.turnId,
      orchestrationId: group.orchestrationId,
      reason,
      releasedText,
      audioReady: group.audioReady,
      noAudioConfirmed: group.noAudioConfirmed,
    });
  }

  function releaseTextOnly(group: PendingTurnPlaybackGroup, reason: string): void {
    if (group.textReleased) {
      return;
    }
    const releasedText = options.releaseText(
      group.messageId,
      group.turnId,
      group.orchestrationId,
    );
    group.textReleased = group.textReleased || releasedText;
    log("text released before audio", {
      messageId: group.messageId,
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
      if (group.audioReady) {
        options.releaseAudio(group.messageId, group.turnId, group.orchestrationId);
        group.audioReady = false;
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
    markTextReady: (
      messageId: string,
      turnId: string | null,
      orchestrationId: string | null,
    ) => {
      const group = getOrCreateGroup(messageId, turnId, orchestrationId);
      group.textReady = true;
      evaluateGroup(group, "text_ready");
    },
    markAudioReady: (
      messageId: string,
      turnId: string | null,
      orchestrationId: string | null,
    ) => {
      const group = getOrCreateGroup(messageId, turnId, orchestrationId);
      group.audioReady = true;
      evaluateGroup(group, "audio_ready");
    },
    markMotionReady: (
      messageId: string,
      turnId: string | null,
      orchestrationId: string | null,
      payload: unknown,
      receivedAtMs: number,
    ) => {
      if (!payload) {
        return;
      }
      const group = getOrCreateGroup(messageId, turnId, orchestrationId);
      group.motionReady = true;
      group.motionPayload = payload;
      group.motionReceivedAtMs = receivedAtMs;
      evaluateGroup(group, "motion_ready");
    },
    markNoAudioConfirmed: (
      messageId: string,
      turnId: string | null,
      orchestrationId: string | null,
    ) => {
      const group = getOrCreateGroup(messageId, turnId, orchestrationId);
      group.noAudioConfirmed = true;
      evaluateGroup(group, "no_audio_terminal");
    },
    markTurnFinished: (
      messageId: string,
      turnId: string | null,
      orchestrationId: string | null,
    ) => {
      const group = getOrCreateGroup(messageId, turnId, orchestrationId);
      group.noAudioConfirmed = group.noAudioConfirmed || !group.audioReady;
      evaluateGroup(group, "turn_finished");
    },
    flush: () => {
      for (const group of groups.values()) {
        evaluateGroup(group, "manual_flush");
      }
    },
    clearSegment: (messageId: string) => {
      const group = groups.get(resolveTurnPlaybackGroupKey(messageId));
      if (!group) {
        return;
      }
      clearReleaseTimer(group);
      deleteGroup(group);
    },
    clear: clearGroups,
    getGroupCount: () => groups.size,
  };
}
