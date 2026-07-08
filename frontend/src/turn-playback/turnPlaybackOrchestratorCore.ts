// Orchestrator startup window: once text/audio are present, keep a wider window
// for a late motion plan to join the same playback group before releasing.
export const AUDIO_MOTION_SYNC_WAIT_MS = 820;
export const TEXT_ONLY_RELEASE_WAIT_MS = 260;

export interface PendingTurnPlaybackGroup<TMotionPayload = unknown> {
  key: string;
  messageId: string;
  turnId: string | null;
  firstReadyAtMs: number;
  textReady: boolean;
  audioExpected: boolean;
  audioReady: boolean;
  noAudioConfirmed: boolean;
  motionReady: boolean;
  motionPayload: TMotionPayload | null;
  motionReceivedAtMs: number;
  textReleased: boolean;
  released: boolean;
  releaseTimer: unknown | null;
}

export interface TurnPlaybackSegmentReleaseJob<TMotionPayload = unknown> {
  messageId: string;
  turnId: string | null;
  reason: string;
  text: {
    release: boolean;
  };
  audio: {
    release: boolean;
    noAudioConfirmed: boolean;
  };
  motion: {
    payload: TMotionPayload | null;
    receivedAtMs: number | null;
  };
}

export interface TurnPlaybackSegmentReleaseResult {
  releasedText: boolean;
  releasedAudio: boolean;
  releasedMotion: boolean;
}

export interface TurnPlaybackOrchestratorCoreOptions<TMotionPayload = unknown> {
  now: () => number;
  schedule: (delayMs: number, fn: () => void) => unknown;
  clearSchedule: (timer: unknown) => void;
  releaseSegment: (
    job: TurnPlaybackSegmentReleaseJob<TMotionPayload>,
  ) => TurnPlaybackSegmentReleaseResult;
  log?: (message: string, details: Record<string, unknown>) => void;
}

export function resolveTurnPlaybackGroupKey(
  turnId: string | null,
  messageId: string,
): string {
  const normalizedTurnId = typeof turnId === "string" ? turnId.trim() : "";
  const normalizedMessageId = typeof messageId === "string" ? messageId.trim() : "";
  if (!normalizedMessageId) {
    throw new Error("Turn playback group requires a non-empty messageId.");
  }
  return `segment:${normalizedTurnId || "anonymous"}:${normalizedMessageId}`;
}

export function createTurnPlaybackOrchestratorCore<TMotionPayload = unknown>(
  options: TurnPlaybackOrchestratorCoreOptions<TMotionPayload>,
) {
  const groups = new Map<string, PendingTurnPlaybackGroup<TMotionPayload>>();

  function log(message: string, details: Record<string, unknown>): void {
    options.log?.(message, details);
  }

  function getOrCreateGroup(
    messageId: string,
    turnId: string | null,
  ): PendingTurnPlaybackGroup<TMotionPayload> {
    const key = resolveTurnPlaybackGroupKey(turnId, messageId);
    const existing = groups.get(key);
    if (existing) {
      existing.turnId = existing.turnId ?? turnId;
      return existing;
    }

    const group: PendingTurnPlaybackGroup<TMotionPayload> = {
      key,
      messageId,
      turnId,
      firstReadyAtMs: options.now(),
      textReady: false,
      audioExpected: false,
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

  function deleteGroup(group: PendingTurnPlaybackGroup<TMotionPayload>): void {
    groups.delete(group.key);
  }

  function clearReleaseTimer(group: PendingTurnPlaybackGroup<TMotionPayload>): void {
    if (group.releaseTimer !== null) {
      options.clearSchedule(group.releaseTimer);
      group.releaseTimer = null;
    }
  }

  function scheduleEvaluate(
    group: PendingTurnPlaybackGroup<TMotionPayload>,
    delayMs: number,
  ): void {
    clearReleaseTimer(group);
    group.releaseTimer = options.schedule(Math.max(0, Math.round(delayMs)), () => {
      group.releaseTimer = null;
      evaluateGroup(group, "timer");
    });
  }

  function releaseGroup(
    group: PendingTurnPlaybackGroup<TMotionPayload>,
    reason: string,
  ): void {
    clearReleaseTimer(group);
    group.released = true;
    const result = releaseSegmentJob(group, {
      reason,
      releaseText: !group.textReleased,
      releaseAudio: group.audioReady,
      releaseMotion: group.motionReady && group.motionPayload !== null,
    });
    log("group released", {
      messageId: group.messageId,
      turnId: group.turnId,
      reason,
      releasedText: result.releasedText,
      audioReady: group.audioReady,
      noAudioConfirmed: group.noAudioConfirmed,
    });
  }

  function releaseTextOnly(
    group: PendingTurnPlaybackGroup<TMotionPayload>,
    reason: string,
  ): void {
    if (group.textReleased) {
      return;
    }
    const result = releaseSegmentJob(group, {
      reason,
      releaseText: true,
      releaseAudio: false,
      releaseMotion: false,
    });
    log("text released before audio", {
      messageId: group.messageId,
      turnId: group.turnId,
      reason,
      releasedText: result.releasedText,
    });
  }

  function releaseSegmentJob(
    group: PendingTurnPlaybackGroup<TMotionPayload>,
    optionsForJob: {
      reason: string;
      releaseText: boolean;
      releaseAudio: boolean;
      releaseMotion: boolean;
    },
  ): TurnPlaybackSegmentReleaseResult {
    const motionPayload = optionsForJob.releaseMotion
      ? group.motionPayload
      : null;
    const motionReceivedAtMs = optionsForJob.releaseMotion
      ? group.motionReceivedAtMs
      : null;
    if (
      optionsForJob.releaseMotion
      && (
        motionReceivedAtMs === null
        || !Number.isFinite(motionReceivedAtMs)
        || motionReceivedAtMs < 0
      )
    ) {
      throw new Error("Motion segment release requires a valid receivedAtMs.");
    }
    const result = options.releaseSegment({
      messageId: group.messageId,
      turnId: group.turnId,
      reason: optionsForJob.reason,
      text: {
        release: optionsForJob.releaseText,
      },
      audio: {
        release: optionsForJob.releaseAudio,
        noAudioConfirmed: group.noAudioConfirmed,
      },
      motion: {
        payload: motionPayload,
        receivedAtMs: motionReceivedAtMs,
      },
    });
    group.textReleased = group.textReleased || result.releasedText;
    if (optionsForJob.releaseAudio) {
      group.audioReady = !result.releasedAudio;
    }
    if (result.releasedMotion) {
      group.motionPayload = null;
      group.motionReady = false;
    }
    if (motionPayload !== null) {
      log("motion released", {
        messageId: group.messageId,
        turnId: group.turnId,
        reason: optionsForJob.reason,
      });
    }
    return result;
  }

  function evaluateGroup(
    group: PendingTurnPlaybackGroup<TMotionPayload>,
    reason: string,
  ): void {
    if (group.released) {
      if (group.motionReady || group.audioReady) {
        releaseSegmentJob(group, {
          reason: `late_release_after_${reason}`,
          releaseText: false,
          releaseAudio: group.audioReady,
          releaseMotion: group.motionReady && group.motionPayload !== null,
        });
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

    if (group.audioExpected) {
      clearReleaseTimer(group);
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
      alreadyReleased = false,
    ) => {
      const group = getOrCreateGroup(messageId, turnId);
      group.textReady = true;
      group.textReleased = group.textReleased || alreadyReleased;
      evaluateGroup(group, "text_ready");
    },
    markAudioReady: (
      messageId: string,
      turnId: string | null,
    ) => {
      const group = getOrCreateGroup(messageId, turnId);
      group.audioReady = true;
      evaluateGroup(group, "audio_ready");
    },
    markAudioExpected: (
      messageId: string,
      turnId: string | null,
    ) => {
      const group = getOrCreateGroup(messageId, turnId);
      group.audioExpected = true;
      evaluateGroup(group, "audio_expected");
    },
    markMotionReady: (
      messageId: string,
      turnId: string | null,
      payload: TMotionPayload,
      receivedAtMs: number,
    ) => {
      if (!payload) {
        return;
      }
      const group = getOrCreateGroup(messageId, turnId);
      group.motionReady = true;
      group.motionPayload = payload;
      group.motionReceivedAtMs = receivedAtMs;
      evaluateGroup(group, "motion_ready");
    },
    markNoAudioConfirmed: (
      messageId: string,
      turnId: string | null,
    ) => {
      const group = getOrCreateGroup(messageId, turnId);
      group.noAudioConfirmed = true;
      evaluateGroup(group, "no_audio_terminal");
    },
    markOutputQueueClosed: (
      messageId: string,
      turnId: string | null,
    ) => {
      const group = getOrCreateGroup(messageId, turnId);
      evaluateGroup(group, "output_queue_closed");
    },
    flush: () => {
      for (const group of groups.values()) {
        evaluateGroup(group, "manual_flush");
      }
    },
    clearSegment: (turnId: string | null, messageId: string) => {
      const group = groups.get(resolveTurnPlaybackGroupKey(turnId, messageId));
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
