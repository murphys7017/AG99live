import { onScopeDispose, watch } from "vue";
import type { useAdapterConnection } from "./useAdapterConnection";
import type { useModelEngine } from "../model-engine/useModelEngine";

type AdapterConnection = ReturnType<typeof useAdapterConnection>;
type ModelEngine = ReturnType<typeof useModelEngine>;

const AUDIO_MOTION_SYNC_WAIT_MS = 820;
const TEXT_ONLY_RELEASE_WAIT_MS = 260;

interface PendingTurnPlaybackGroup {
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
  releaseTimer: number;
}

interface TurnPlaybackOrchestratorOptions {
  adapter: AdapterConnection;
  modelEngine: ModelEngine;
}

function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveGroupKey(turnId: string | null, orchestrationId: string | null): string {
  const normalizedOrchestrationId = normalizeId(orchestrationId);
  if (normalizedOrchestrationId) {
    return `orch:${normalizedOrchestrationId}`;
  }
  const normalizedTurnId = normalizeId(turnId);
  if (normalizedTurnId) {
    return `turn:${normalizedTurnId}`;
  }
  return "unknown";
}

function nowMs(): number {
  return performance.now();
}

export function useTurnPlaybackOrchestrator(
  options: TurnPlaybackOrchestratorOptions,
) {
  const groups = new Map<string, PendingTurnPlaybackGroup>();

  function getOrCreateGroup(
    turnId: string | null,
    orchestrationId: string | null,
  ): PendingTurnPlaybackGroup {
    const key = resolveGroupKey(turnId, orchestrationId);
    const existing = groups.get(key);
    if (existing) {
      existing.turnId = existing.turnId ?? turnId;
      existing.orchestrationId = existing.orchestrationId ?? orchestrationId;
      return existing;
    }

    const group: PendingTurnPlaybackGroup = {
      turnId,
      orchestrationId,
      firstReadyAtMs: nowMs(),
      textReady: false,
      audioReady: false,
      noAudioConfirmed: false,
      motionReady: false,
      motionPayload: null,
      motionReceivedAtMs: 0,
      textReleased: false,
      released: false,
      releaseTimer: 0,
    };
    groups.set(key, group);
    return group;
  }

  function clearReleaseTimer(group: PendingTurnPlaybackGroup): void {
    if (group.releaseTimer) {
      window.clearTimeout(group.releaseTimer);
      group.releaseTimer = 0;
    }
  }

  function scheduleEvaluate(
    group: PendingTurnPlaybackGroup,
    delayMs: number,
  ): void {
    clearReleaseTimer(group);
    group.releaseTimer = window.setTimeout(() => {
      group.releaseTimer = 0;
      evaluateGroup(group, "timer");
    }, Math.max(0, Math.round(delayMs)));
  }

  function releaseMotion(group: PendingTurnPlaybackGroup, reason: string): void {
    if (!group.motionReady || group.motionPayload === null) {
      return;
    }
    const payload = group.motionPayload;
    group.motionPayload = null;
    group.motionReady = false;
    options.modelEngine.ingestInboundPayload(payload, {
      turnId: group.turnId,
      orchestrationId: group.orchestrationId,
      receivedAtMs: group.motionReceivedAtMs || nowMs(),
    });
    console.info("[TurnPlaybackOrchestrator] motion released.", {
      turnId: group.turnId,
      orchestrationId: group.orchestrationId,
      reason,
    });
  }

  function releaseGroup(
    group: PendingTurnPlaybackGroup,
    reason: string,
  ): void {
    clearReleaseTimer(group);
    group.released = true;
    const releasedText = options.adapter.releaseAssistantTextForPlayback(
      group.turnId,
      group.orchestrationId,
    );
    group.textReleased = group.textReleased || releasedText;
    releaseMotion(group, reason);
    void options.adapter.releaseAudioForPlayback(
      group.turnId,
      group.orchestrationId,
    );
    console.info("[TurnPlaybackOrchestrator] group released.", {
      turnId: group.turnId,
      orchestrationId: group.orchestrationId,
      reason,
      releasedText,
      audioReady: group.audioReady,
      noAudioConfirmed: group.noAudioConfirmed,
    });
  }

  function releaseTextOnly(
    group: PendingTurnPlaybackGroup,
    reason: string,
  ): void {
    if (group.textReleased) {
      return;
    }
    const releasedText = options.adapter.releaseAssistantTextForPlayback(
      group.turnId,
      group.orchestrationId,
    );
    group.textReleased = group.textReleased || releasedText;
    console.info("[TurnPlaybackOrchestrator] text released before audio.", {
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
      const elapsedMs = nowMs() - group.firstReadyAtMs;
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

    const elapsedMs = nowMs() - group.firstReadyAtMs;
    if (elapsedMs >= TEXT_ONLY_RELEASE_WAIT_MS) {
      releaseTextOnly(group, `text_wait_elapsed:${reason}`);
      return;
    }
    scheduleEvaluate(group, TEXT_ONLY_RELEASE_WAIT_MS - elapsedMs);
  }

  function markTextReady(): void {
    const group = getOrCreateGroup(
      options.adapter.state.pendingAssistantTextTurnId,
      options.adapter.state.pendingAssistantTextOrchestrationId,
    );
    group.textReady = true;
    evaluateGroup(group, "text_ready");
  }

  function markAudioReady(): void {
    const group = getOrCreateGroup(
      options.adapter.state.pendingAudioTurnId,
      options.adapter.state.pendingAudioOrchestrationId,
    );
    group.audioReady = true;
    evaluateGroup(group, "audio_ready");
  }

  function markMotionReady(): void {
    const payload = options.adapter.state.inboundMotionPlan;
    if (!payload) {
      return;
    }
    const group = getOrCreateGroup(
      options.adapter.state.inboundMotionPlanTurnId,
      options.adapter.state.inboundMotionPlanOrchestrationId,
    );
    group.motionReady = true;
    group.motionPayload = payload;
    group.motionReceivedAtMs = options.adapter.state.inboundMotionPlanReceivedAtMs;
    evaluateGroup(group, "motion_ready");
  }

  function markNoAudioIfTerminal(): void {
    if (options.adapter.state.audioPlaybackTerminalState !== "not_requested") {
      return;
    }
    const group = getOrCreateGroup(
      options.adapter.state.audioPlaybackTerminalTurnId,
      options.adapter.state.audioPlaybackTerminalOrchestrationId,
    );
    group.noAudioConfirmed = true;
    evaluateGroup(group, "no_audio_terminal");
  }

  function markTurnFinished(): void {
    const group = getOrCreateGroup(
      options.adapter.state.turnFinishedTurnId,
      options.adapter.state.turnFinishedOrchestrationId,
    );
    group.noAudioConfirmed = group.noAudioConfirmed || !group.audioReady;
    evaluateGroup(group, "turn_finished");
  }

  function clearGroups(): void {
    for (const group of groups.values()) {
      clearReleaseTimer(group);
    }
    groups.clear();
  }

  watch(
    () => options.adapter.state.pendingAssistantTextNonce,
    markTextReady,
  );
  watch(
    () => options.adapter.state.pendingAudioNonce,
    markAudioReady,
  );
  watch(
    () => options.adapter.state.inboundMotionPlanNonce,
    markMotionReady,
  );
  watch(
    () => options.adapter.state.audioPlaybackTerminalNonce,
    markNoAudioIfTerminal,
  );
  watch(
    () => options.adapter.state.turnFinishedNonce,
    markTurnFinished,
  );
  watch(
    () => options.adapter.state.currentTurnId,
    (turnId) => {
      options.modelEngine.notifyCurrentTurnChanged(turnId);
    },
  );

  onScopeDispose(() => {
    clearGroups();
  });

  return {
    flush: () => {
      for (const group of groups.values()) {
        evaluateGroup(group, "manual_flush");
      }
    },
  };
}
