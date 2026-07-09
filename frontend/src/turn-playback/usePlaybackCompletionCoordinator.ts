/**
 * 播放完成协调器。负责本地回环到后端的最后一步：
 *   1. 持续观察会话存储里所有段的进度（text.delivered / audio.terminal /
 *      motion.{absent,started,completed,failed}）和后端三段信号；
 *   2. 在合适时机调用 playbackAck.sendPlaybackFinishedForCurrentGroup（发回
 *      control.playback_finished）并 markPhase(session, "settling")；
 *   3. 收到后端 backend.turnFinished 后调用 finalizeCompletion → playbackAck
 *      .clearPlaybackGroupContext + markPhase "completed"，会话至此真正闭环。
 *
 * 还附带管理：
 *   - 已 ack 会话遇到晚到音频时反向 reopen（reopenAckedSessionForLateAudio），
 *     允许这一段重新参与释放；
 *   - 动作播放记录 motionPlaybackRecords（用于桌面投影/调试），同段重复记录
 *     在 MOTION_RECORD_DEDUP_WINDOW_MS 内会覆盖头一条。
 *
 * 边界：不直接控制播放器、不解析信封；通过 deps（playbackAck / motionRecord /
 * motionPlayer / sessionStore）注入所有副作用。
 */

import { shallowReadonly, ref, watch } from "vue";
import type { ModelEnginePlanStartedEvent } from "../model-engine/runtime/contracts";
import type { DirectParameterPlanTerminalEvent } from "../types/live2d-runtime.d.ts";
import type { DesktopMotionPlaybackRecord } from "../types/desktop";
import type { usePreviewMotionPlayer } from "../live2d-renderer/usePreviewMotionPlayer";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import { isPlaybackLocallySettled } from "./selectors.js";
import type { TurnPlaybackSegment, TurnPlaybackSession } from "./session.js";
import { cloneJson } from "../utils/cloneJson.js";
import type {
  MotionPlaybackRecordPort,
  PlaybackAckPort,
} from "./ports.js";

type PreviewMotionPlayer = ReturnType<typeof usePreviewMotionPlayer>;
type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

const DEFAULT_MAX_MOTION_PLAYBACK_RECORDS = 5;
const MOTION_RECORD_DEDUP_WINDOW_MS = 1200;

interface PlaybackCompletionCoordinatorOptions {
  sessionStore: SessionStore;
  playbackAck: PlaybackAckPort;
  motionRecord: MotionPlaybackRecordPort;
  motionPlayer: PreviewMotionPlayer;
  schedule?: (delayMs: number, fn: () => void) => unknown;
  clearSchedule?: (timer: unknown) => void;
  initialMotionPlaybackRecords?: readonly DesktopMotionPlaybackRecord[];
  maxMotionPlaybackRecords?: number;
  writeMotionSessionLifecycle?: boolean;
  onMotionLabRawEvent?: (
    payload: {
      event_type: string;
      source_route?: string;
      phase?: string;
      model_name?: string;
      profile_id?: string;
      profile_revision?: number;
      assistant_text?: string;
      payload_kind?: string;
      raw: Record<string, unknown>;
    },
    turnId?: string | null,
  ) => void;
}

/**
 * 装配完成协调器。在当前组件/作用域内绑定三组 watch（音频起播通知、
 * 文本 delivered/late-audio 触发 flush、动作 player 状态收口），返回外部可用的
 * recordMotionPlayback（动作引擎播放成功后回调写入记录）和
 * resetPlaybackCoordination（断连/重置时清干内部去重集合）。
 */
export function usePlaybackCompletionCoordinator(
  options: PlaybackCompletionCoordinatorOptions,
) {
  const motionPlaybackRecords = ref<DesktopMotionPlaybackRecord[]>(
    (options.initialMotionPlaybackRecords ?? []).map((record) =>
      cloneJson(record) as DesktopMotionPlaybackRecord),
  );
  const maxMotionPlaybackRecords =
    options.maxMotionPlaybackRecords ?? DEFAULT_MAX_MOTION_PLAYBACK_RECORDS;
  const writeMotionSessionLifecycle =
    options.writeMotionSessionLifecycle !== false;
  // Lightweight internal state — session is the single source of truth
  const ackedSessions = new Set<string>();
  const activeMotionSegments = new Set<string>();
  let currentMotionSegmentKey: string | null = null;

  // ── helpers ─────────────────────────────────────────────────────

  function getSession(sessionId: string | null) {
    return sessionId ? options.sessionStore.getSessionById(sessionId) : undefined;
  }

  function segmentKey(sessionId: string, messageId: string): string {
    return `${sessionId}::${messageId}`;
  }

  function findSegmentByKey(key: string | null): {
    session: TurnPlaybackSession;
    segment: TurnPlaybackSegment;
  } | null {
    if (!key) {
      return null;
    }
    const delimiterIndex = key.indexOf("::");
    if (delimiterIndex < 0) {
      return null;
    }
    const sessionId = key.slice(0, delimiterIndex);
    const messageId = key.slice(delimiterIndex + 2);
    const session = getSession(sessionId);
    const segment = session?.segments.get(messageId);
    return session && segment ? { session, segment } : null;
  }

  function findSessionForMotionEvent(
    event: ModelEnginePlanStartedEvent,
  ): TurnPlaybackSession | undefined {
    for (const turnId of [event.turnId, event.playbackTurnId]) {
      const session = options.sessionStore.getSession(turnId);
      if (session?.segments.has(event.messageId)) {
        return session;
      }
    }
    return options.sessionStore.getSessions().find((candidate) =>
      candidate.segmentOrder.some((segmentId) => segmentId === event.messageId),
    );
  }

  /**
   * 清干内部状态：ack 去重集合、活跃动作段集合。用于断连/手动重置：
   * 协调器进入"什么都没发生过"的初始态。
   * 不写会话存储；会话本身的清理由调用方走 pruneSessions 等接口。
   */
  function resetPlaybackCoordination(): void {
    ackedSessions.clear();
    activeMotionSegments.clear();
    currentMotionSegmentKey = null;
  }

  function completeMotionSegmentByKey(
    key: string | null,
    reason: string,
  ): void {
    const found = findSegmentByKey(key);
    if (!found) {
      return;
    }

    options.sessionStore.markMotionCompleted(
      found.segment.turnId,
      found.segment.messageId,
    );
    if (key) {
      activeMotionSegments.delete(key);
    }

    if (found.segment.audio.terminal !== "idle") {
      maybeFlushPlaybackCompletion(
        found.session.id,
        found.segment.messageId,
        reason,
      );
    }
  }

  function finalizeCompletion(sessionId: string): void {
    const s = getSession(sessionId);
    if (!s) return;
    for (const segmentId of s.segmentOrder) {
      activeMotionSegments.delete(segmentKey(sessionId, segmentId));
    }
    ackedSessions.delete(sessionId);
    options.playbackAck.clearPlaybackGroupContext(s.turnId);
    options.sessionStore.markPhase(s.turnId, "completed");
  }

  function maybeFlushPlaybackCompletion(
    sessionId: string,
    messageId: string | null = null,
    reason?: string,
  ): void {
    const s = getSession(sessionId);
    if (!s) return;

    // Never re-ack a session that already reached a terminal phase
    if (s.phase === "completed" || s.phase === "failed") {
      return;
    }

    if (!isPlaybackLocallySettled(s)) {
      return;
    }

    if (!s.backend.synthFinished) {
      return;
    }

    if (ackedSessions.has(sessionId)) {
      if (s.backend.turnFinished) {
        finalizeCompletion(sessionId);
      }
      return;
    }

    const success = s.segmentOrder.every((segmentId) => {
      const segment = s.segments.get(segmentId);
      return segment
        ? segment.audio.terminal !== "failed" && !segment.motion.failed
        : true;
    });
    options.sessionStore.markPhase(s.turnId, "settling");
    ackedSessions.add(sessionId);
    void options.playbackAck.sendPlaybackFinishedForCurrentGroup(
      s.turnId,
      success,
      reason,
    );
    if (s.backend.turnFinished) {
      finalizeCompletion(sessionId);
    }
  }

  function reopenAckedSessionForLateAudio(
    session: TurnPlaybackSession,
    segment: TurnPlaybackSegment,
  ): void {
    if (!ackedSessions.has(session.id)) {
      return;
    }
    if (
      session.phase !== "playing"
      || !segment.audio.url
      || segment.audio.terminal !== "idle"
      || segment.audio.released
    ) {
      return;
    }
    ackedSessions.delete(session.id);
  }

  /**
   * 把动作引擎一次启动事件落到 motionPlaybackRecords，并在会话存储里
   * markMotionStarted。preview 启动（动作实验室）不计入；动作段切换时会先把
   * 上一段以 motion_handed_off 收口（completeMotionSegmentByKey）。
   * 与最近一条记录指纹一致且时间差在 MOTION_RECORD_DEDUP_WINDOW_MS 内时，
   * 用新记录覆盖头一条，避免动作引擎重试时刷出重复条目。
   */
  function recordMotionPlayback(event: ModelEnginePlanStartedEvent): void {
    if (event.startReason === "preview") {
      return;
    }

    const session = findSessionForMotionEvent(event);
    if (session) {
      const key = segmentKey(session.id, event.messageId);
      if (currentMotionSegmentKey && currentMotionSegmentKey !== key) {
        completeMotionSegmentByKey(currentMotionSegmentKey, "motion_handed_off");
      }
      currentMotionSegmentKey = key;
      currentMotionRun = {
        runId: event.runId || key,
        segmentKey: key,
      };
      activeMotionSegments.add(key);
      if (writeMotionSessionLifecycle) {
        options.sessionStore.markMotionStarted(
          event.turnId,
          event.messageId,
        );
      }
    }

    const now = new Date();
    const baseRecord = {
      id: `motion-record-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now.toISOString(),
      source: event.diagnostics?.source || event.startReason,
      payloadKind: event.payloadKind,
      messageId: event.messageId,
      turnId: event.turnId,
      playbackTurnId: event.playbackTurnId,
      modelName: event.model?.name ?? options.motionRecord.getSelectedModel().value?.name ?? "",
      startReason: event.startReason,
      queuedDelayMs: event.queuedDelayMs,
      assistantText: options.motionRecord.getLastAssistantText(),
      playerMessage: event.playerMessage,
      diagnostics: event.diagnostics
        ? {
            ...event.diagnostics,
            axisIntensityScale: { ...event.diagnostics.axisIntensityScale },
          }
        : null,
    };
    const record: DesktopMotionPlaybackRecord = event.payloadKind === "catalog_motion"
      ? {
          ...baseRecord,
          payloadKind: "catalog_motion",
          emotionLabel: event.motion.emotion_label || event.motion.label || event.motion.motion_id,
          mode: "expressive",
          motion: cloneJson(event.motion),
        }
      : {
          ...baseRecord,
          payloadKind: event.payloadKind,
          emotionLabel: event.plan.emotion_label,
          mode: event.plan.mode,
          plan: cloneJson(event.plan),
        };
    const playbackStartedPayload = {
      event_type: "motion.playback_started",
      source_route: event.startReason,
      phase: "playback_started",
      model_name: event.model?.name ?? "",
      profile_id: event.payloadKind === "catalog_motion" ? "" : event.plan.profile_id,
      profile_revision: event.payloadKind === "catalog_motion" ? undefined : event.plan.profile_revision,
      assistant_text: record.assistantText,
      payload_kind: event.payloadKind,
      raw: {
        record,
        intent: event.payloadKind === "semantic_intent" ? cloneJson(event.intent) : null,
        plan: event.payloadKind === "catalog_motion" ? null : cloneJson(event.plan),
        motion: event.payloadKind === "catalog_motion" ? cloneJson(event.motion) : null,
        diagnostics: event.diagnostics ? cloneJson(event.diagnostics) : null,
        playerMessage: event.playerMessage,
        runId: event.runId ?? "",
        queuedDelayMs: event.queuedDelayMs,
      },
    };
    options.onMotionLabRawEvent?.(playbackStartedPayload, event.turnId);
    if (event.payloadKind === "semantic_intent") {
      options.onMotionLabRawEvent?.({
        ...playbackStartedPayload,
        event_type: "motion.frontend_compiled",
        phase: "frontend_compiled",
        raw: {
          record,
          intent: cloneJson(event.intent),
          plan: cloneJson(event.plan),
          diagnostics: event.diagnostics ? cloneJson(event.diagnostics) : null,
          playerMessage: event.playerMessage,
          runId: event.runId ?? "",
          queuedDelayMs: event.queuedDelayMs,
        },
      }, event.turnId);
    }
    if (isDuplicateMotionPlaybackRecord(record, motionPlaybackRecords.value[0])) {
      motionPlaybackRecords.value = [
        record,
        ...motionPlaybackRecords.value.slice(1),
      ];
      return;
    }
    motionPlaybackRecords.value = [
      record,
      ...motionPlaybackRecords.value,
    ].slice(0, maxMotionPlaybackRecords);
  }

  // ── watchers: observe session, write back on completion ─────────


  // Text delivered → try flush
  watch(
    () => options.sessionStore.getSessions().map((session) => ({
      id: session.id,
      segments: session.segmentOrder.map((segmentId) => {
        const segment = session.segments.get(segmentId);
        return {
          messageId: segmentId,
          audioUrl: segment?.audio.url ?? null,
          audioReleased: segment?.audio.released ?? false,
          textDelivered: segment?.text.delivered ?? false,
          audioTerminal: segment?.audio.terminal ?? "idle",
          motionAbsent: segment?.motion.absent ?? false,
          motionStarted: segment?.motion.started ?? false,
          motionCompleted: segment?.motion.completed ?? false,
          motionFailed: segment?.motion.failed ?? false,
        };
      }),
      backendSynthFinished: session.backend.synthFinished,
      backendTurnFinished: session.backend.turnFinished,
      phase: session.phase,
    })),
    () => {
      for (const session of options.sessionStore.getSessions()) {
        if (session.phase === "completed" || session.phase === "failed") {
          continue;
        }
        for (const segmentId of session.segmentOrder) {
          const segment = session.segments.get(segmentId);
          if (segment) {
            reopenAckedSessionForLateAudio(session, segment);
          }
          if (segment?.text.delivered) {
            maybeFlushPlaybackCompletion(session.id, segment.messageId, "text_delivered");
          }
        }
      }
    },
    { deep: true },
  );

  /** 当前正在播放的动作 { runId, segmentKey }。由 recordMotionPlayback 设置，
   *  completeMotionPlayback 按 runId 校验后消费。不依赖全局 status watch。 */
  let currentMotionRun: { runId: string; segmentKey: string } | null = null;

  /**
   * 由 usePreviewMotionPlayer 的 onFinished 回调调用。
   * 校验 event.runId 防止 stale callback 收错段，使用 findSegmentByKey 定位段。
   */
  function completeMotionPlayback(event: DirectParameterPlanTerminalEvent): void {
    if (!currentMotionRun || currentMotionRun.runId !== event.runId) {
      return;
    }

    const terminalSegment = findSegmentByKey(currentMotionRun.segmentKey);
    options.onMotionLabRawEvent?.({
      event_type: event.status === "completed"
        ? "motion.playback_completed"
        : "motion.playback_failed",
      source_route: "frontend_motion_player",
      phase: "playback_terminal",
      raw: {
        runId: event.runId,
        status: event.status,
        reason: event.reason ?? "",
        segmentKey: currentMotionRun.segmentKey,
        turnId: terminalSegment?.segment.turnId ?? null,
        messageId: terminalSegment?.segment.messageId ?? "",
      },
    }, terminalSegment?.segment.turnId ?? null);

    if (event.status === "completed") {
      if (writeMotionSessionLifecycle) {
        completeMotionSegmentByKey(currentMotionRun.segmentKey, "motion_completed_after_audio");
      } else {
        activeMotionSegments.delete(currentMotionRun.segmentKey);
      }
    } else if (event.status === "stopped") {
      // started motion must always reach a terminal state; otherwise playback_finished can stall.
      const found = findSegmentByKey(currentMotionRun.segmentKey);
      if (found && writeMotionSessionLifecycle) {
        options.sessionStore.markMotionFailed(
          found.segment.turnId,
          found.segment.messageId,
          event.reason || "motion_stopped_without_terminal",
        );
      }
      activeMotionSegments.delete(currentMotionRun.segmentKey);
    } else {
      const found = findSegmentByKey(currentMotionRun.segmentKey);
      if (found && writeMotionSessionLifecycle) {
        options.sessionStore.markMotionFailed(
          found.segment.turnId,
          found.segment.messageId,
          event.reason || event.status,
        );
      }
      activeMotionSegments.delete(currentMotionRun.segmentKey);
    }

    currentMotionRun = null;
  }

  return {
    motionPlaybackRecords: shallowReadonly(motionPlaybackRecords),
    recordMotionPlayback,
    completeMotionPlayback,
    resetPlaybackCoordination,
  };
}

function isDuplicateMotionPlaybackRecord(
  next: DesktopMotionPlaybackRecord,
  previous: DesktopMotionPlaybackRecord | undefined,
): boolean {
  if (!previous) {
    return false;
  }
  const nextCreatedAt = Date.parse(next.createdAt);
  const previousCreatedAt = Date.parse(previous.createdAt);
  if (
    Number.isFinite(nextCreatedAt)
    && Number.isFinite(previousCreatedAt)
    && Math.abs(nextCreatedAt - previousCreatedAt) > MOTION_RECORD_DEDUP_WINDOW_MS
  ) {
    return false;
  }
  return (
    previous.messageId === next.messageId
    && previous.turnId === next.turnId
    && previous.playbackTurnId === next.playbackTurnId
    && previous.payloadKind === next.payloadKind
    && previous.startReason === next.startReason
    && buildMotionRecordSignature(previous) === buildMotionRecordSignature(next)
  );
}

function buildMotionRecordSignature(record: DesktopMotionPlaybackRecord): string {
  if (record.payloadKind === "catalog_motion") {
    return [
      record.motion.motion_id,
      record.motion.group,
      record.motion.index,
      record.motion.file,
    ].join("|");
  }
  return [
    record.plan.schema_version,
    record.plan.profile_id,
    record.plan.profile_revision,
    record.plan.mode,
    record.plan.emotion_label,
    record.plan.timing.duration_ms,
    record.plan.parameters
      .map((parameter) => [
        parameter.axis_id,
        parameter.parameter_id,
        parameter.input_value ?? "",
        parameter.target_value,
        parameter.weight,
        parameter.source ?? "",
      ].join(":"))
      .join(";"),
  ].join("|");
}
