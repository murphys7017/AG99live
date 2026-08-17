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
 *   - 正式协议只通过 commitOutputSegment 一次性创建完整段；段级 mark* 只更新
 *     已提交段的 timeline 生命周期，缺段时直接抛错。
 *   - 后端 turn/synth/finished 信号要求 session 已存在，synth_finished 不推断
 *     缺失材料，也不把未解析状态改写为 absent。
 *   - phase 转移统一经 markPhaseInternal 做合法性检查；非法转移直接抛错，
 *     避免协议副作用在状态写入失败后继续执行。
 *   - 段写入不通过计时器猜测 readiness；phase 只由原子提交、timeline 生命周期
 *     和完成协调器显式推进。
 *
 * 边界：
 *   - 不知道协议形状，也不收发任何消息。
 *   - 不调度任何定时器；队列关闭由入站协议标记，完成协调器只判断本地播放是否已收口。
 *   - 暴露的 state 是 readonly 包装，外部只能通过 mark* / setActiveSession / prune* 写入。
 */

import { reactive, readonly } from "vue";
import type {
  TurnPlaybackSession,
  TurnPlaybackPhase,
  AudioTerminalState,
  TurnPlaybackSegment,
  OutputSegmentCommitResult,
  OutputSegmentMaterial,
} from "./session.js";
import {
  createTurnPlaybackSession,
  createTurnPlaybackSegment,
  resolveSessionId,
  isTerminalPhase,
  isValidPhaseTransition,
  isSegmentLocallySettled,
} from "./session.js";
import { getActivePlaybackSegment } from "./selectors.js";

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
    pruneSessions();
  }

  // ── segments ────────────────────────────────────────────────────

  function getSegmentSession(
    turnId: string | null,
    messageId: string,
  ): { session: TurnPlaybackSession; segment: TurnPlaybackSegment } {
    const session = requireSession(turnId);
    const segmentId = normalizeRequiredMessageId(messageId);
    const segment = session.segments.get(segmentId);
    if (!segment) {
      throw new Error(
        `Playback lifecycle update requires committed segment: turnId=${turnId}, messageId=${segmentId}.`,
      );
    }
    return { session, segment };
  }

  function getSegment(
    sessionId: string | null,
    messageId: string,
  ): TurnPlaybackSegment | undefined {
    const segmentId = normalizeRequiredMessageId(messageId);
    return getSessionById(sessionId)?.segments.get(segmentId);
  }

  function getMotionTerminal(
    segment: TurnPlaybackSegment,
  ): "absent" | "completed" | "failed" | null {
    if (segment.motion.absent) {
      return "absent";
    }
    if (segment.motion.completed) {
      return "completed";
    }
    if (segment.motion.failed) {
      return "failed";
    }
    return null;
  }

  function rejectTerminalRewrite(
    material: "text" | "audio" | "motion" | "turn",
    current: string,
    next: string,
  ): void {
    console.warn(
      "[TurnPlaybackSessionStore] terminal rewrite ignored; first terminal is stable.",
      {
        material,
        current,
        next,
      },
    );
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

  function assertOutputSegmentsResolved(turnId: string | null): void {
    const session = requireSession(turnId);
    if (session.segmentOrder.length === 0) {
      throw new Error(`Atomic output segment missing before synth_finished: turnId=${turnId}.`);
    }
    for (const messageId of session.segmentOrder) {
      const segment = session.segments.get(messageId);
      if (!segment) {
        throw new Error(`Turn playback segment order is corrupt: messageId=${messageId}.`);
      }
      if (segment.rejected) {
        continue;
      }
      const textResolved = Boolean(segment.text.content) || segment.text.delivered;
      const audioResolved = Boolean(segment.audio.url) || segment.audio.terminal !== "idle";
      const motionResolved = Boolean(segment.motion.payload)
        || segment.motion.absent
        || segment.motion.failed;
      if (!textResolved || !audioResolved || !motionResolved) {
        throw new Error(
          `Incomplete atomic output segment before synth_finished: turnId=${turnId}, messageId=${messageId}.`,
        );
      }
    }
  }

  function getActiveSegment(sessionId: string | null): TurnPlaybackSegment | null {
    const session = getSessionById(sessionId);
    return session ? getActivePlaybackSegment(session) : null;
  }

  /**
   * 一次性提交已经完整校验的 output.segment。
   *
   * 这里是正式入站段唯一的创建边界。先在局部对象中构建全部子状态，所有
   * 前置条件通过后才把段放入 session Map，避免动作校验或重复段错误留下
   * 已显示文本、已排队音频等半提交状态。
   */
  function commitOutputSegment(
    turnId: string | null,
    messageId: string,
    material: OutputSegmentMaterial,
  ): OutputSegmentCommitResult {
    const session = requireSession(turnId);
    const segmentId = normalizeRequiredMessageId(messageId);
    if (isTerminalPhase(session.phase)) {
      return {
        status: "rejected",
        reason: `output_segment_session_terminal:${turnId}:${segmentId}`,
      };
    }
    if (session.backend.synthFinished) {
      return {
        status: "rejected",
        reason: `output_segment_after_synth_finished:${turnId}:${segmentId}`,
      };
    }
    if (session.segments.has(segmentId)) {
      return {
        status: "rejected",
        reason: `output_segment_duplicate:${turnId}:${segmentId}`,
      };
    }

    const receivedAtMs = performance.now();
    const segment = createTurnPlaybackSegment(segmentId, turnId);

    if (material.state === "rejected") {
      const rejectionReason = material.reason.trim();
      if (!rejectionReason) {
        throw new Error(`Rejected output segment requires a reason: messageId=${segmentId}.`);
      }
      segment.rejected = true;
      segment.rejectionReason = rejectionReason;
      session.segments.set(segmentId, segment);
      session.segmentOrder.push(segmentId);
      if (session.phase === "collecting") {
        markPhaseInternal(session, "ready");
      }
      log("atomic output segment rejected", {
        sessionId: session.id,
        messageId: segmentId,
        turnId,
        reason: rejectionReason,
      });
      return { status: "committed" };
    }

    if (material.text.state === "present") {
      segment.text.content = material.text.content;
      segment.text.receivedAtMs = receivedAtMs;
      segment.text.receiveMode = "replace";
    } else if (material.text.state === "absent") {
      segment.text.released = true;
      segment.text.delivered = true;
      segment.text.reason = "output_segment_text_absent";
    } else {
      segment.text.released = true;
      segment.text.delivered = true;
      segment.text.failed = true;
      segment.text.reason = material.text.reason;
    }

    if (material.audio.state === "present") {
      segment.audio.url = material.audio.url;
      segment.audio.receivedAtMs = receivedAtMs;
    } else {
      segment.audio.released = true;
      segment.audio.terminal = material.audio.state;
      segment.audio.reason = material.audio.state === "failed"
        ? material.audio.reason
        : "output_segment_audio_absent";
    }

    if (material.motion.state === "present") {
      segment.motion.payload = material.motion.payload;
      segment.motion.receivedAtMs = receivedAtMs;
    } else if (material.motion.state === "absent") {
      segment.motion.absent = true;
      segment.motion.reason = "output_segment_motion_absent";
    } else {
      segment.motion.released = true;
      segment.motion.failed = true;
      segment.motion.reason = material.motion.reason;
    }

    if (material.speech.state === "present") {
      segment.speech.cues = material.speech.cues.map((cue) => ({ ...cue }));
      segment.speech.receivedAtMs = receivedAtMs;
    }

    session.segments.set(segmentId, segment);
    session.segmentOrder.push(segmentId);
    if (session.phase === "collecting") {
      markPhaseInternal(session, "ready");
    }
    log("atomic output segment committed", {
      sessionId: session.id,
      messageId: segmentId,
      turnId,
      textState: material.text.state,
      audioState: material.audio.state,
      motionState: material.motion.state,
      speechState: material.speech.state,
      speechCueCount: material.speech.state === "present" ? material.speech.cues.length : 0,
    });
    return { status: "committed" };
  }

  // ── text ────────────────────────────────────────────────────────

  function markTextDelivered(
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    if (segment.text.delivered) {
      if (segment.text.failed) {
        rejectTerminalRewrite("text", "failed", "delivered");
        return;
      }
      return;
    }
    segment.text.delivered = true;
    segment.text.released = true; // delivery implies release
    segment.text.failed = false;
    segment.text.reason = "";
  }

  function markTextFailed(
    turnId: string | null,
    messageId: string,
    reason: string,
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    if (segment.text.delivered) {
      if (segment.text.failed) {
        return;
      }
      rejectTerminalRewrite("text", "delivered", "failed");
      return;
    }
    segment.text.released = true;
    segment.text.delivered = true;
    segment.text.failed = true;
    segment.text.reason = reason;
  }

  // ── audio ───────────────────────────────────────────────────────

  function markAudioStarted(
    turnId: string | null,
    messageId: string,
    startedAtMs?: number | null,
    durationMs?: number | null,
  ): void {
    const { segment, session } = getSegmentSession(turnId, messageId);
    if (segment.audio.terminal !== "idle") {
      rejectTerminalRewrite("audio", segment.audio.terminal, "started");
      return;
    }
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
    if (session.phase === "ready" || session.phase === "settling") {
      markPhaseInternal(session, "playing");
    }
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
    if (segment.audio.terminal !== "idle") {
      if (segment.audio.terminal === terminal) {
        return;
      }
      rejectTerminalRewrite("audio", segment.audio.terminal, terminal);
      return;
    }
    segment.audio.released = true;
    segment.audio.terminal = terminal;
    segment.audio.reason = reason || segment.audio.reason;
  }

  function markAudioReleased(
    turnId: string | null,
    messageId: string,
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    if (segment.audio.terminal !== "idle") {
      rejectTerminalRewrite("audio", segment.audio.terminal, "released");
      return;
    }
    segment.audio.released = true;
  }

  // ── motion ──────────────────────────────────────────────────────

  function markMotionAbsent(
    turnId: string | null,
    messageId: string,
    reason = "",
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    const currentTerminal = getMotionTerminal(segment);
    if (currentTerminal) {
      if (currentTerminal === "absent") {
        return;
      }
      rejectTerminalRewrite("motion", currentTerminal, "absent");
      return;
    }
    segment.motion.payload = null;
    segment.motion.receivedAtMs = null;
    segment.motion.absent = true;
    segment.motion.released = false;
    segment.motion.started = false;
    segment.motion.completed = false;
    segment.motion.failed = false;
    segment.motion.reason = reason;
  }

  function markMotionFailed(
    turnId: string | null,
    messageId: string,
    reason = "",
  ): void {
    const { segment } = getSegmentSession(turnId, messageId);
    const currentTerminal = getMotionTerminal(segment);
    if (currentTerminal) {
      if (currentTerminal === "failed") {
        return;
      }
      rejectTerminalRewrite("motion", currentTerminal, "failed");
      return;
    }
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
    const currentTerminal = getMotionTerminal(segment);
    if (currentTerminal) {
      rejectTerminalRewrite("motion", currentTerminal, "released");
      return;
    }
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
    const currentTerminal = getMotionTerminal(segment);
    if (currentTerminal) {
      rejectTerminalRewrite("motion", currentTerminal, "started");
      return;
    }
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
    const currentTerminal = getMotionTerminal(segment);
    if (currentTerminal) {
      if (currentTerminal === "completed") {
        return;
      }
      rejectTerminalRewrite("motion", currentTerminal, "completed");
      return;
    }
    segment.motion.absent = false;
    segment.motion.failed = false;
    segment.motion.reason = "";
    segment.motion.released = true;
    segment.motion.completed = true;
  }

  // ── backend ─────────────────────────────────────────────────────

  function markTurnStarted(
    turnId: string,
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
  ): boolean {
    const session = requireSession(turnId);
    const normalizedReason = reason.trim();
    if (session.backend.turnFinished) {
      const current = `${session.backend.success === true}:${session.backend.reason}`;
      const next = `${success}:${normalizedReason}`;
      if (current !== next) {
        rejectTerminalRewrite("turn", current, next);
      }
      return false;
    }
    if (
      (session.phase === "completed" && !success)
      || (session.phase === "failed" && success)
    ) {
      rejectTerminalRewrite(
        "turn",
        session.phase,
        `${success ? "completed" : "failed"}:${normalizedReason}`,
      );
      return false;
    }
    if (!success) {
      markPhaseInternal(session, "failed");
    }
    session.backend.turnFinished = true;
    session.backend.success = success;
    session.backend.reason = normalizedReason || session.backend.reason;
    return true;
  }

  // ── interrupt ───────────────────────────────────────────────────

  function markInterrupt(
    turnId: string | null,
  ): boolean {
    const session = requireSession(turnId);
    if (session.interrupted) {
      return false;
    }
    if (isTerminalPhase(session.phase) || session.backend.turnFinished) {
      rejectTerminalRewrite("turn", session.phase, "interrupted");
      return false;
    }
    markPhaseInternal(session, "failed");
    session.interrupted = true;
    session.backend.reason = session.backend.reason || "interrupted";
    log("session interrupted", {
      id: session.id,
      turnId: session.turnId,
    });
    return true;
  }

  function markSessionFailed(
    turnId: string | null,
    reason: string,
  ): boolean {
    const session = requireSession(turnId);
    if (isTerminalPhase(session.phase)) {
      if (session.phase !== "failed") {
        rejectTerminalRewrite("turn", session.phase, `failed:${reason}`);
      }
      return false;
    }
    markPhaseInternal(session, "failed");
    session.backend.reason = reason || session.backend.reason;
    return true;
  }

  // ── phase ───────────────────────────────────────────────────────

  /**
   * 阶段转移：相同阶段直接返回 true（幂等）；非法转移抛错且不改 session.phase。
   * 合法转移表见
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
      throw new Error(
        `Turn playback session illegal phase transition: ${session.phase} -> ${phase}`
        + ` (sessionId=${session.id})`,
      );
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
    getSession,
    getSessionById,
    getSegment,
    getActiveSegment,
    getUnsettledSegments,
    isSegmentSettled,
    assertOutputSegmentsResolved,
    getSessions,
    getActiveSession,
    setActiveSession,
    commitOutputSegment,
    markTextDelivered,
    markTextFailed,
    markAudioReleased,
    markAudioStarted,
    markAudioDuration,
    markAudioTerminal,
    markMotionAbsent,
    markMotionFailed,
    markMotionReleased,
    markMotionStarted,
    markMotionCompleted,
    markTurnStarted,
    markSynthFinished,
    markTurnFinished,
    markInterrupt,
    markSessionFailed,
    markPhase,
    finalizeSession,
    pruneSessions,
  };
}
