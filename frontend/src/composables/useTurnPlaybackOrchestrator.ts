import { onScopeDispose, watch } from "vue";
import type { useAdapterConnection } from "./useAdapterConnection";
import type { useModelEngine } from "../model-engine/useModelEngine";
import { createTurnPlaybackOrchestratorCore } from "./turnPlaybackOrchestratorCore";

type AdapterConnection = ReturnType<typeof useAdapterConnection>;
type ModelEngine = ReturnType<typeof useModelEngine>;

interface TurnPlaybackOrchestratorOptions {
  adapter: AdapterConnection;
  modelEngine: ModelEngine;
}

export function useTurnPlaybackOrchestrator(
  options: TurnPlaybackOrchestratorOptions,
) {
  const core = createTurnPlaybackOrchestratorCore({
    now: () => performance.now(),
    schedule: (delayMs, fn) => window.setTimeout(fn, delayMs),
    clearSchedule: (timer) => {
      window.clearTimeout(timer as number);
    },
    releaseText: (turnId, orchestrationId) =>
      options.adapter.releaseAssistantTextForPlayback(turnId, orchestrationId),
    releaseAudio: (turnId, orchestrationId) => {
      void options.adapter.releaseAudioForPlayback(turnId, orchestrationId);
    },
    releaseMotion: (payload, context) => {
      options.modelEngine.ingestInboundPayload(payload, context);
    },
    log: (message, details) => {
      console.info(`[TurnPlaybackOrchestrator] ${message}.`, details);
    },
  });

  function markTextReady(): void {
    core.markTextReady(
      options.adapter.state.pendingAssistantTextTurnId,
      options.adapter.state.pendingAssistantTextOrchestrationId,
    );
  }

  function markAudioReady(): void {
    core.markAudioReady(
      options.adapter.state.pendingAudioTurnId,
      options.adapter.state.pendingAudioOrchestrationId,
    );
  }

  function markMotionReady(): void {
    const payload = options.adapter.state.inboundMotionPlan;
    if (!payload) {
      return;
    }
    core.markMotionReady(
      options.adapter.state.inboundMotionPlanTurnId,
      options.adapter.state.inboundMotionPlanOrchestrationId,
      payload,
      options.adapter.state.inboundMotionPlanReceivedAtMs,
    );
  }

  function markNoAudioIfTerminal(): void {
    if (options.adapter.state.audioPlaybackTerminalState !== "not_requested") {
      return;
    }
    core.markNoAudioConfirmed(
      options.adapter.state.audioPlaybackTerminalTurnId,
      options.adapter.state.audioPlaybackTerminalOrchestrationId,
    );
  }

  function markTurnFinished(): void {
    core.markTurnFinished(
      options.adapter.state.turnFinishedTurnId,
      options.adapter.state.turnFinishedOrchestrationId,
    );
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
    core.clear();
  });

  return {
    flush: () => {
      core.flush();
    },
  };
}
