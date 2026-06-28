/**
 * 播放会话存储。
 *
 * 是文本/音频/动作三类入站材料在前端唯一的归宿，也是播放编排器、完成协调器、
 * 桌面投影读取播放进度的事实来源。
 *
 * 模型：
 *   sessions: Map<sessionId, TurnPlaybackSession>   一个 turnId 对应一份会话
 *   每个 session 内含 segments: Map<messageId, segment>，段是 text/audio/motion
 *   三个子状态 + turnId/messageId 的组合。
 *
 * 写入约定：
 *   - 文本/音频/动作这类段级 mark* 会通过 ensureSegment 现场创建缺失段；
 *     后端 turn/synth/finished 信号要求 session 已存在。
 *   - phase 转移统一经 markPhaseInternal 做合法性检查；非法转移只记 warn、
 *     不抛异常，保持事件投递不被打断。
 *   - 大多数段写入不主动推进 phase；例外是晚到 audio 在 settling 阶段会把
 *     session 重新拨回 playing，给补到的媒体一次释放机会。
 *
 * 边界：
 *   - 不知道协议形状，也不收发任何消息。
 *   - 不调度任何定时器；时间相关的逻辑（settlement window 等）在完成协调器里。
 *   - 暴露的 state 是 readonly 包装，外部只能通过 mark* / setActiveSession / prune* 写入。
 */

import { reactive, readonly } from "vue";
import type {
  TurnPlaybackSession,
  TurnPlaybackPhase,
  TextReceiveMode,
  AudioTerminalState,
  TurnPlaybackSegment,
} from "./session.js";
import {
  createTurnPlaybackSession,
  createTurnPlaybackSegment,
  resolveSessionId,
  isValidPhaseTransition,
  isSegmentLocallySettled,
} from "./session.js";
import { getActivePlaybackSegment } from "./selectors.js";
import type { NormalizedMotionPayload } from "../model-engine/contracts.js";
import type { PerformanceCurveHint } from "../types/protocol.js";

// ── Store state ────────────────────────────────────────────────────

interface SessionStoreState {
  sessions: Map<string, TurnPlaybackSession>;
  activeSessionId: string | null;
}

// ── Store ──────────────────────────────────────────────────────────

/**
 * 创建一份新的会话存储实例。
 *
 * 内部用 Vue reactive 持有 sessions Map + activeSessionId；返回的 state 是 readonly 视图，
 * 写入必须走 mark* / setActiveSession / pruneSessions 这些方法。整套 API 是同步的，
 * 不做任何 I/O，可被多个调用方共享（依赖注入下，主控制器装配一份并下发到适配器、
 * 播放编排、完成协调、投影发布等所有消费者）。
 */
export function useTurnPlaybackSessionStore() {
  const state = reactive<SessionStoreState>({
    sessions: new Map(),
    activeSessionId: null,
  });

  // ── helpers ─────────────────────────────────────────────────────

  function log(message: string, details?: Record<string, unknown>): void {
    console.info(`[TurnPlaybackSessionStore] ${message}.`, details ?? {});
  }

  function normalizeRequiredMessageId(messageId: string): string {
    const normalized = messageId.trim();
    if (!normalized) {
      throw new Error("Turn playback segment requires a non-empty messageId.");
    }
    return normalized;
  }

  // ── session lookup / creation ───────────────────────────────────

  function ensureSession(
    turnId: string | null = null,
  ): TurnPlaybackSession {
    const resolvedKey = resolveSessionId(turnId);
    if (!resolvedKey) {
      throw new Error("Turn playback session requires turnId.");
    }
    const key = resolvedKey;

    const existing = state.sessions.get(key);
    if (existing) {
      // Fill in turnId if it was missing on creation
      if (!existing.turnId && turnId) {
        const normalizedTurnId = typeof turnId === "string" ? turnId.trim() : "";
        if (normalizedTurnId) {
          existing.turnId = normalizedTurnId;
        }
      }
      return existing;
    }

    const session = createTurnPlaybackSession(turnId);
    state.sessions.set(key, session);
    log("session created", {
      id: session.id,
      turnId: turnId ?? null,
    });
    return session;
  }

  function getSession(turnId: string | null): TurnPlaybackSession | undefined {
    const sessionId = resolveSessionId(turnId);
    return sessionId ? state.sessions.get(sessionId) : undefined;
  }

  function requireSession(turnId: string | null): TurnPlaybackSession {
    const session = getSession(turnId);
    if (session) {
      return session;
    }
    throw new Error(`Turn playback session does not exist for turnId=${turnId ?? "null"}.`);
  }

  function getActiveSession(): TurnPlaybackSession | undefined {
    if (!state.activeSessionId) {
      return undefined;
    }
    return state.sessions.get(state.activeSessionId);
  }

  function getSessionById(sessionId: string | null): TurnPlaybackSession | undefined {
    if (!sessionId) {
      return undefined;
    }
    return state.sessions.get(sessionId);
  }

  function getSessions(): TurnPlaybackSession[] {
    return Array.from(state.sessions.values());
  }

  function setActiveSession(
    turnId: string | null = null,
  ): void {
    const key = resolveSessionId(turnId);
    if (!key) {
      state.activeSessionId = null;
      return;
    }
    const session = ensureSession(turnId);
    state.activeSessionId = session.id;
  }

  // ── segments ────────────────────────────────────────────────────

  function ensureSegment(
    turnId: string | null,
    messageId: string,
  ): TurnPlaybackSegment {
    const session = ensureSession(turnId);
    return ensureSegmentForSession(session, turnId, messageId);
  }

  function ensureSegmentForSession(
    session: TurnPlaybackSession,
    turnId: string | null,
    messageId: string,
  ): TurnPlaybackSegment {
    const segmentId = normalizeRequiredMessageId(messageId);
    const existing = session.segments.get(segmentId);
    if (existing) {
      if (!existing.turnId && turnId) {
        existing.turnId = turnId;
      }
      return existing;
    }

    const segment = createTurnPlaybackSegment(segmentId, turnId);
    session.segments.set(segmentId, segment);
    session.segmentOrder.push(segmentId);
    log("segment created", {
      sessionId: session.id,
      messageId: segmentId,
      turnId,
    });
    return segment;
  }

  function getSegmentSession(
    turnId: string | null,
    messageId: string,
  ): { session: TurnPlaybackSession; segment: TurnPlaybackSegment } {
    const session = ensureSession(turnId);
    const segment = ensureSegmentForSession(session, turnId, messageId);
    return { session, segment };
  }

  function getSegment(
    sessionId: string | null,
    messageId: string,
  ): TurnPlaybackSegment | undefined {
    const segmentId = normalizeRequiredMessageId(messageId);
    return getSessionById(sessionId)?.segments.get(segmentId);
  }

  function getUnsettledSegments(): TurnPlaybackSegment[] {
    const unsettled: TurnPlaybackSegment[] = [];
    for (const session of state.sessions.values()) {
      for (const segmentId of session.segmentOrder) {
        const segment = session.segments.get(segmentId);
        if (segment && !isSegmentLocallySettled(segment)) {
          unsettled.push(segment);
        }
      }
    }
    return unsettled;
  }

  function isSegmentSettled(sessionId: string | null, messageId: string): boolean {
    const segment = getSegment(sessionId, messageId);
    return Boolean(segment && isSegmentLocallySettled(segment));
  }

  function getActiveSegment(sessionId: string | null): TurnPlaybackSegment | null {
    const session = getSessionById(sessionId);
    return session ? getActivePlaybackSegment(session) : null;
  }

  // ── text ────────────────────────────────────────────────────────

  function markTextReceived(
    turnId: string | null,
    text: string,
    messageId: string,
    mode: TextReceiveMode = "replace",
  ): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const { session, segment } = getSegmentSession(turnId, messageId);
    if (mode === "append" && segment.text.content) {
      segment.text.content = segment.text.content + trimmed;
    } else {
      segment.text.content = trimmed;
    }
    segment.text.receiveMode = mode;
    segment.text.receivedAtMs = performance.now();
    if (!session.backend.turnStarted) {
      session.backend.turnStarted = true;
    }
  }

  function markTextReleased(
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    segment.text.released = true;
  }

  function markTextDelivered(
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    segment.text.delivered = true;
    segment.text.released = true; // delivery implies release
  }

  // ── audio ───────────────────────────────────────────────────────

  /**
   * 收到新音频：写入 url 并把段重置为可播状态。
   *
   * 已经有过 url，且段已 released/started 或 terminal != "idle" 时，视为重复音频，
   * 返回 false 由调用方决定是否上报"已忽略重复音频"。会话若处于 settling，
   * 收到一份新 url 会把 phase 拨回 playing，给晚到媒体一次补齐机会。
   */
  function markAudioReceived(
    turnId: string | null,
    url: string,
    messageId: string,
  ): boolean {
    const trimmed = url.trim();
    if (!trimmed) {
      return false;
    }
    const { session, segment } = getSegmentSession(turnId, messageId);
    const hasExistingAudioUrl =
      typeof segment.audio.url === "string"
      && segment.audio.url.trim().length > 0;
    if (
      hasExistingAudioUrl
      && (
        segment.audio.released
        || segment.audio.started
        || segment.audio.terminal !== "idle"
      )
    ) {
      return false;
    }
    segment.audio.url = trimmed;
    segment.audio.receivedAtMs = performance.now();
    segment.audio.released = false;
    segment.audio.terminal = "idle";
    segment.audio.reason = "";
    segment.audio.started = false;
    segment.audio.startedAtMs = null;
    segment.audio.durationMs = null;
    if (session.phase === "settling") {
      markPhaseInternal(session, "playing");
    }
    return true;
  }

  function markAudioStarted(
    turnId: string | null,
    messageId: string,
    startedAtMs?: number | null,
    durationMs?: number | null,
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    segment.audio.released = true;
    segment.audio.started = true;
    segment.audio.startedAtMs =
      typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
        ? startedAtMs
        : performance.now();
    segment.audio.durationMs =
      typeof durationMs === "number" && Number.isFinite(durationMs)
        ? durationMs
        : null;
  }

  function markAudioDuration(
    turnId: string | null,
    messageId: string,
    durationMs: number | null,
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    segment.audio.durationMs =
      typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
        ? durationMs
        : null;
  }

  function markAudioTerminal(
    turnId: string | null,
    terminal: Exclude<AudioTerminalState, "idle">,
    messageId: string,
    reason = "",
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    segment.audio.released = true;
    segment.audio.terminal = terminal;
    segment.audio.reason = reason || segment.audio.reason;
  }

  function markAudioReleased(
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    segment.audio.released = true;
  }

  // ── motion ──────────────────────────────────────────────────────

  /**
   * 收到一份动作载荷。如果段动作已经 released/started/completed，直接 return，
   * 不覆盖正在播或已收口的动作。写入会同时清掉 absent/failed/reason 标记，
   * 让段重新具备"等待动作播放"的语义。
   */
  function markMotionReceived(
    turnId: string | null,
    payload: NormalizedMotionPayload,
    messageId: string,
  ): void {
    if (!payload) {
      return;
    }
    const { segment } = getSegmentSession(turnId, messageId);
    if (
      segment.motion.released
      || segment.motion.started
      || segment.motion.completed
    ) {
      return;
    }
    segment.motion.payload = payload;
    segment.motion.receivedAtMs = performance.now();
    segment.motion.absent = false;
    segment.motion.released = false;
    segment.motion.started = false;
    segment.motion.completed = false;
    segment.motion.failed = false;
    segment.motion.reason = "";
  }

  function markPerformanceCurveHintReceived(
    turnId: string | null,
    hint: PerformanceCurveHint,
    messageId: string,
  ): void {
    if (!hint) {
      return;
    }
    const { segment } = getSegmentSession(turnId, messageId);
    if (
      segment.motion.released
      || segment.motion.started
      || segment.motion.completed
    ) {
      return;
    }
    segment.motion.performanceCurveHint = hint;
    segment.motion.performanceCurveHintReceivedAtMs = performance.now();
  }

  function markMotionAbsent(
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    segment.motion.payload = null;
    segment.motion.receivedAtMs = null;
    segment.motion.performanceCurveHint = null;
    segment.motion.performanceCurveHintReceivedAtMs = null;
    segment.motion.absent = true;
    segment.motion.released = false;
    segment.motion.started = false;
    segment.motion.completed = true;
    segment.motion.failed = false;
    segment.motion.reason = "";
  }

  function markMotionFailed(
    turnId: string | null,
    messageId: string,
    reason = "",
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    segment.motion.absent = false;
    segment.motion.released = true;
    segment.motion.started = false;
    segment.motion.completed = false;
    segment.motion.failed = true;
    segment.motion.reason = reason || segment.motion.reason;
  }

  function markMotionReleased(
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    segment.motion.absent = false;
    segment.motion.failed = false;
    segment.motion.reason = "";
    segment.motion.released = true;
  }

  function markMotionStarted(
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    segment.motion.absent = false;
    segment.motion.failed = false;
    segment.motion.reason = "";
    segment.motion.released = true;
    segment.motion.started = true;
  }

  function markMotionCompleted(
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    segment.motion.absent = false;
    segment.motion.failed = false;
    segment.motion.reason = "";
    segment.motion.released = true;
    segment.motion.completed = true;
  }

  // ── backend ─────────────────────────────────────────────────────

  function markTurnStarted(
    turnId: string | null,
  ): void {
    const session = ensureSession(turnId);
    session.backend.turnStarted = true;
  }

  function markSynthFinished(
    turnId: string | null,
  ): void {
    const session = requireSession(turnId);
    session.backend.synthFinished = true;
  }

  function markTurnFinished(
    turnId: string | null,
    success: boolean,
    reason = "",
  ): void {
    const session = requireSession(turnId);
    session.backend.turnFinished = true;
    session.backend.success = success;
    session.backend.reason = reason || session.backend.reason;
  }

  // ── interrupt ───────────────────────────────────────────────────

  /**
   * 把活跃会话标为已中断。
   *
   * 实际行为：
   *   - 没有活跃会话时直接 return（不创建新会话，不复活已结算会话）；
   *   - 写 interrupted = true、backend.reason = "interrupted"（已有 reason 优先保留）；
   *   - markPhaseInternal(session, "failed")；非法转移（已是终态）会只记 warn 不报错。
   * 入参 turnId 当前不用于查找目标；调用方需要先把 activeSessionId 对齐到
   * 目标会话，或接受"中断当前活跃会话"的语义。
   */
  function markInterrupt(
    turnId: string | null,
  ): void {
    void turnId;
    const session = getActiveSession();
    if (!session) {
      return;
    }
    session.interrupted = true;
    session.backend.reason = session.backend.reason || "interrupted";
    markPhaseInternal(session, "failed");
    log("session interrupted", {
      id: session.id,
      activeSessionId: state.activeSessionId,
    });
  }

  // ── phase ───────────────────────────────────────────────────────

  /**
   * 阶段转移：相同阶段直接返回 true（幂等）；非法转移只记 warn 并返回 false，
   * 不抛异常、不改 session.phase，避免事件投递被状态机错误打断。合法转移表见
   * session.ts/VALID_PHASE_TRANSITIONS。
   */
  function markPhaseInternal(
    session: TurnPlaybackSession,
    phase: TurnPlaybackPhase,
  ): boolean {
    if (session.phase === phase) {
      return true; // idempotent
    }
    if (!isValidPhaseTransition(session.phase, phase)) {
      console.warn(
        `[TurnPlaybackSessionStore] illegal phase transition: ${session.phase} -> ${phase}`,
        { sessionId: session.id },
      );
      return false;
    }
    session.phase = phase;
    return true;
  }

  function markPhase(
    turnId: string | null,
    phase: TurnPlaybackPhase,
  ): boolean {
    const session = requireSession(turnId);
    return markPhaseInternal(session, phase);
  }

  // ── finalize / prune ─────────────────────────────────────────────

  /**
   * 尝试把会话推到 completed。仅做 phase 转移（受合法性检查约束）；
   * 调用方（完成协调器）负责决定"什么时候"调用。
   */
  function finalizeSession(
    turnId: string | null,
  ): boolean {
    const session = requireSession(turnId);
    return markPhaseInternal(session, "completed");
  }

  /**
   * 清理已到终态（completed/failed）的旧会话，仅保留活跃会话和最近 keepRecent
   * 条终态会话（按插入顺序保留新的、丢弃老的）。activeSession 永不删；
   * 删除发生时记一条 pruned sessions 日志。
   */
  function pruneSessions(keepRecent = 3): void {
    const terminalSessions: TurnPlaybackSession[] = [];
    const toDelete: string[] = [];

    for (const [id, session] of state.sessions) {
      if (session.phase === "completed" || session.phase === "failed") {
        if (id === state.activeSessionId) {
          continue;
        }
        terminalSessions.push(session);
      }
    }

    // Keep the most recent terminal sessions in insertion order.
    // A simple approach: drop oldest first.
    const deleteCount = Math.max(0, terminalSessions.length - keepRecent);
    for (let i = 0; i < deleteCount; i++) {
      const session = terminalSessions[i];
      toDelete.push(session.id);
    }

    for (const id of toDelete) {
      state.sessions.delete(id);
    }

    if (toDelete.length > 0) {
      log("pruned sessions", { deleted: toDelete.length, remaining: state.sessions.size });
    }
  }

  // ── public API ──────────────────────────────────────────────────

  return {
    state: readonly(state),
    ensureSession,
    requireSession,
    ensureSegment,
    getSession,
    getSessionById,
    getSegment,
    getActiveSegment,
    getUnsettledSegments,
    isSegmentSettled,
    getSessions,
    getActiveSession,
    setActiveSession,
    markTextReceived,
    markTextReleased,
    markTextDelivered,
    markAudioReceived,
    markAudioReleased,
    markAudioStarted,
    markAudioDuration,
    markAudioTerminal,
    markMotionReceived,
    markPerformanceCurveHintReceived,
    markMotionAbsent,
    markMotionFailed,
    markMotionReleased,
    markMotionStarted,
    markMotionCompleted,
    markTurnStarted,
    markSynthFinished,
    markTurnFinished,
    markInterrupt,
    markPhase,
    finalizeSession,
    pruneSessions,
  };
}
