/**
 * 段释放编排：把会话存储里的段状态变化翻译成 segment release job。
 *
 * 自身不维护播放时机逻辑（那部分在 turnPlaybackOrchestratorCore 里），只做两件事：
 *   1. 装配 core，把"该释放什么"交给 PlaybackTimelineRuntime.startSegmentJob() 统一启动；
 *   2. 用 Vue watch 深度观察所有会话的段，把段当前状态喂给 core（textReady /
 *      audioReady / motionReady / outputQueueClosed / noAudioConfirmed），让 core
 *      根据时机决策出"该释放谁"。
 *
 * 另外两个 watch 处理活跃会话切换：
 *   - 切换后 core.flush()，避免上一组挂着的等待计时器影响新组；
 *   - 切换后通知 motionPayload.notifyCurrentTurnChanged(turnId)，让动作引擎刷新归属。
 *
 * 边界：不发协议、不直接触发音频/动作播放；返回 flush()
 * 用于外部强制刷新等待中的释放（如打断、断连后）。
 */

import { onScopeDispose, watch } from "vue";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import type { NormalizedMotionPayload } from "../model-engine/contracts";
import type { PerformanceCurveHint } from "../types/protocol.js";
import {
  createTurnPlaybackOrchestratorCore,
} from "./turnPlaybackOrchestratorCore.js";
import {
  canReleaseAudio,
  canReleaseMotion,
  getActivePlaybackSegment,
} from "./selectors.js";
import { isSegmentLocallySettled } from "./session.js";
import type {
  MotionPayloadPort,
} from "./ports.js";
import type {
  PlaybackTimelineSegmentStartPort,
} from "../playback-timeline/segmentJob.js";

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;
const AUDIO_EXPECTED_TIMEOUT_MS = 3000;

interface TurnPlaybackOrchestratorOptions {
  sessionStore: SessionStore;
  motionPayload: Pick<MotionPayloadPort, "notifyCurrentTurnChanged">;
  timelineRuntime: PlaybackTimelineSegmentStartPort<NormalizedMotionPayload>;
}

function attachPerformanceCurveHintToPayload(
  payload: NormalizedMotionPayload,
  hint: PerformanceCurveHint | null,
): NormalizedMotionPayload {
  if (!hint || payload.kind !== "semantic_intent") {
    return payload;
  }
  return {
    ...payload,
    intent: {
      ...payload.intent,
      performance_curve_hint: hint,
    },
  };
}

/**
 * 在当前组件/作用域内装配段释放编排，并把生命周期挂到 onScopeDispose（卸载时 core.clear）。
 * 返回 { flush } 供外部在打断/断连等场景强制清干等待中的释放。
 */
export function useTurnPlaybackOrchestrator(
  options: TurnPlaybackOrchestratorOptions,
) {
  const audioExpectedTimers = new Map<string, number>();
  const core = createTurnPlaybackOrchestratorCore<NormalizedMotionPayload>({
    now: () => performance.now(),
    schedule: (delayMs, fn) => window.setTimeout(fn, delayMs),
    clearSchedule: (timer) => {
      window.clearTimeout(timer as number);
    },
    releaseSegment: options.timelineRuntime.startSegmentJob,
    log: (message, details) => {
      console.info(`[TurnPlaybackOrchestrator] ${message}.`, details);
    },
  });

  function segmentTimerKey(turnId: string | null, messageId: string): string {
    const normalizedTurnId = typeof turnId === "string" ? turnId.trim() : "";
    return `${normalizedTurnId.length}:${normalizedTurnId}:${messageId}`;
  }

  function clearAudioExpectedTimer(turnId: string | null, messageId: string): void {
    const key = segmentTimerKey(turnId, messageId);
    const timer = audioExpectedTimers.get(key);
    if (timer === undefined) {
      return;
    }
    window.clearTimeout(timer);
    audioExpectedTimers.delete(key);
  }

  function scheduleAudioExpectedTimeout(turnId: string | null, messageId: string): void {
    const key = segmentTimerKey(turnId, messageId);
    if (audioExpectedTimers.has(key)) {
      return;
    }
    const timer = window.setTimeout(() => {
      audioExpectedTimers.delete(key);
      const session = options.sessionStore.getSession(turnId);
      const segment = session?.segments.get(messageId);
      if (
        !segment
        || segment.audio.url
        || segment.audio.released
        || segment.audio.started
        || segment.audio.terminal !== "idle"
      ) {
        return;
      }
      options.sessionStore.markAudioTerminal(
        turnId,
        "failed",
        messageId,
        "audio_expected_timeout",
      );
    }, AUDIO_EXPECTED_TIMEOUT_MS);
    audioExpectedTimers.set(key, timer);
  }

  // ── Watch session state and feed to core ────────────────────────

  watch(
    () => options.sessionStore.getSessions().flatMap((session) =>
      session.segmentOrder.map((segmentId) => {
        const segment = session.segments.get(segmentId);
        const activeSegment = getActivePlaybackSegment(session);
        return {
          sessionId: session.id,
          sessionPhase: session.phase,
          backendSynthFinished: session.backend.synthFinished,
          activeSegmentId: activeSegment?.messageId ?? null,
          segmentId,
          turnId: segment?.turnId ?? null,
          textContent: segment?.text.content ?? null,
          textReleased: segment?.text.released ?? false,
          textDelivered: segment?.text.delivered ?? false,
          audioUrl: segment?.audio.url ?? null,
          audioExpected: segment?.audio.expected ?? false,
          audioReleased: segment?.audio.released ?? false,
          audioTerminal: segment?.audio.terminal ?? "idle",
          motionReceivedAtMs: segment?.motion.receivedAtMs ?? null,
          performanceCurveHintReceivedAtMs:
            segment?.motion.performanceCurveHintReceivedAtMs ?? null,
          motionReleased: segment?.motion.released ?? false,
          motionCompleted: segment?.motion.completed ?? false,
          motionAbsent: segment?.motion.absent ?? false,
          motionFailed: segment?.motion.failed ?? false,
          hasMotionPayload: segment?.motion.payload !== null,
        };
      }),
    ),
    () => {
      for (const session of options.sessionStore.getSessions()) {
        if (session.phase === "completed" || session.phase === "failed") {
          for (const segmentId of session.segmentOrder) {
            core.clearSegment(session.turnId, segmentId);
          }
          continue;
        }

        for (const segmentId of session.segmentOrder) {
          const candidate = session.segments.get(segmentId);
          if (candidate && isSegmentLocallySettled(candidate)) {
            clearAudioExpectedTimer(candidate.turnId, candidate.messageId);
            core.clearSegment(candidate.turnId, candidate.messageId);
          }
        }

        const segment = getActivePlaybackSegment(session);
        if (!segment) {
          continue;
        }

        if (session.phase === "collecting" && (segment.text.content || segment.text.delivered)) {
          options.sessionStore.markPhase(segment.turnId, "ready");
        }

        if (segment.text.content || segment.text.delivered) {
          core.markTextReady(
            segment.messageId,
            segment.turnId,
            segment.text.released || segment.text.delivered,
          );
        }

        if (segment.audio.expected) {
          core.markAudioExpected(segment.messageId, segment.turnId);
          if (
            !segment.audio.url
            && !segment.audio.released
            && !segment.audio.started
            && segment.audio.terminal === "idle"
          ) {
            scheduleAudioExpectedTimeout(segment.turnId, segment.messageId);
          } else {
            clearAudioExpectedTimer(segment.turnId, segment.messageId);
          }
        } else if (
          segment.audio.url
          || segment.audio.released
          || segment.audio.started
          || segment.audio.terminal !== "idle"
        ) {
          clearAudioExpectedTimer(segment.turnId, segment.messageId);
        }

        if (canReleaseAudio(segment)) {
          clearAudioExpectedTimer(segment.turnId, segment.messageId);
          core.markAudioReady(segment.messageId, segment.turnId);
        }

        if (canReleaseMotion(segment) && segment.motion.payload) {
          const motionReceivedAtMs = segment.motion.receivedAtMs;
          if (
            motionReceivedAtMs === null
            || !Number.isFinite(motionReceivedAtMs)
            || motionReceivedAtMs < 0
          ) {
            options.sessionStore.markMotionFailed(
              segment.turnId,
              segment.messageId,
              "motion_received_at_missing",
            );
          } else {
            core.markMotionReady(
              segment.messageId,
              segment.turnId,
              attachPerformanceCurveHintToPayload(
                segment.motion.payload,
                segment.motion.performanceCurveHint,
              ),
              motionReceivedAtMs,
            );
          }
        }

        if (segment.audio.terminal !== "idle") {
          clearAudioExpectedTimer(segment.turnId, segment.messageId);
        }

        if (
          segment.audio.terminal === "absent"
          || segment.audio.terminal === "failed"
        ) {
          core.markNoAudioConfirmed(
            segment.messageId,
            segment.turnId,
          );
        }

        if (session.backend.synthFinished) {
          core.markOutputQueueClosed(
            segment.messageId,
            segment.turnId,
          );
        }
      }
    },
    { deep: true },
  );

  // Active session changed → flush stale groups
  watch(
    () => options.sessionStore.state.activeSessionId,
    () => {
      core.flush();
    },
  );

  // Forward turn changes to model engine
  watch(
    () => options.sessionStore.state.activeSessionId,
    (sessionId) => {
      const s = sessionId
        ? options.sessionStore.state.sessions.get(sessionId)
        : undefined;
      options.motionPayload.notifyCurrentTurnChanged(s?.turnId ?? null);
    },
  );

  onScopeDispose(() => {
    for (const timer of audioExpectedTimers.values()) {
      window.clearTimeout(timer);
    }
    audioExpectedTimers.clear();
    core.clear();
  });

  return {
    flush: () => {
      core.flush();
    },
  };
}
