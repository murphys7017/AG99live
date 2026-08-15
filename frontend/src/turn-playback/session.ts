/**
 * 播放会话数据契约。
 *
 * 会话与段的关系：
 *   一个 turnId        → 一个 TurnPlaybackSession（id = resolveSessionId(turnId)）
 *   一个 messageId     → 一个 TurnPlaybackSegment（挂在 session.segments）
 *   一个 segment 包含  → text / audio / motion 三个子状态 + turnId/messageId
 *
 * 会话阶段（phase）走有限状态机：
 *   collecting → ready → playing → settling → completed
 *                    ↘ settling       ↘ playing （settling 还可以回到 playing）
 *   任意非终态阶段都可以失败到 failed。
 *   终态：completed / failed（isTerminalPhase）；终态后不接受任何转移。
 *
 * 边界：
 *   - 纯数据结构 + 构造器 + 谓词，不依赖任何 store / I/O。
 *   - 状态写入由 useTurnPlaybackSessionStore 之类的持有者完成；本文件不变更对象。
 *   - 段终态判定（isSegmentLocallySettled）：text.delivered && audio.terminal 非 idle &&
 *     motion 已 absent/completed/failed 三者之一。
 */

import type { NormalizedMotionPayload } from "../types/motion.js";

// ── Phase ──────────────────────────────────────────────────────────

export type TurnPlaybackPhase =
  | "collecting"
  | "ready"
  | "playing"
  | "settling"
  | "completed"
  | "failed";

const VALID_PHASE_TRANSITIONS: Record<TurnPlaybackPhase, TurnPlaybackPhase[]> = {
  collecting: ["ready", "failed"],
  ready: ["playing", "settling", "failed"],
  playing: ["settling", "failed"],
  settling: ["playing", "completed", "failed"],
  completed: [],
  failed: [],
};

const TERMINAL_PHASES: ReadonlySet<TurnPlaybackPhase> = new Set([
  "completed",
  "failed",
]);

/**
 * 是否为终态阶段（completed / failed）。终态后不再接受任何阶段转移。
 */
export function isTerminalPhase(phase: TurnPlaybackPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/**
 * 阶段转移合法性查询。
 *
 * 终态 from 一律返回 false；其余按 VALID_PHASE_TRANSITIONS 表查询。
 * ready → settling 用于没有任何可执行 sink 的完整原子段；settling → playing
 * 保留给已经由 timeline 持有、随后重新进入执行态的段。
 */
export function isValidPhaseTransition(
  from: TurnPlaybackPhase,
  to: TurnPlaybackPhase,
): boolean {
  if (isTerminalPhase(from)) {
    return false;
  }
  return VALID_PHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Audio terminal ─────────────────────────────────────────────────

export type AudioTerminalState = "idle" | "completed" | "failed" | "absent";

// ── Text receive mode ──────────────────────────────────────────────

export type TextReceiveMode = "replace" | "append";

// ── Session sub-states ─────────────────────────────────────────────

/**
 * 段的文本子状态。
 *   content      已收到的文本，未收到为 null
 *   receiveMode  replace = 替换，append = 追加
 *   released     文本是否已被播放协调器释放（推到 UI 显示）
 *   delivered    文本是否真正显示完毕
 */
export interface TurnPlaybackSessionText {
  content: string | null;
  receivedAtMs: number | null;
  receiveMode: TextReceiveMode;
  released: boolean;
  delivered: boolean;
  failed: boolean;
  reason: string;
}

/**
 * 段的音频子状态。
 *   url        音频地址，未收到为 null
 *   released   是否已经把音频交给播放器（pending 出队）
 *   started    本地音频是否真正开播
 *   terminal   播放终态：idle/completed/failed/absent，详见 AudioTerminalState
 *   reason     terminal != "completed" 时的失败/缺失原因，仅供诊断
 */
export interface TurnPlaybackSessionAudio {
  url: string | null;
  receivedAtMs: number | null;
  released: boolean;
  started: boolean;
  startedAtMs: number | null;
  durationMs: number | null;
  terminal: AudioTerminalState;
  reason: string;
}

/**
 * 段的动作子状态。
 *
 * 四个互斥终态：
 *   absent     段不需要动作（无 payload）
 *   completed  动作播放完成
 *   failed     有 payload 但编译/启动/排队丢弃失败（reason 记录失败原因）
 *   （以上三者任一为 true 时，本段对动作视为已结算）
 * released/started 表示动作生命周期推进；payload 为 null 表示尚未收到任何动作意图。
 */
export interface TurnPlaybackSessionMotion {
  payload: NormalizedMotionPayload | null;
  receivedAtMs: number | null;
  released: boolean;
  started: boolean;
  completed: boolean;
  absent: boolean;
  failed: boolean;
  reason: string;
}

export type OutputSegmentTextMaterial =
  | { state: "present"; content: string }
  | { state: "absent" }
  | { state: "failed"; reason: string };

export type OutputSegmentAudioMaterial =
  | { state: "present"; url: string }
  | { state: "absent" }
  | { state: "failed"; reason: string };

export type OutputSegmentMotionMaterial =
  | { state: "present"; payload: NormalizedMotionPayload }
  | { state: "absent" }
  | { state: "failed"; reason: string };

/**
 * 已通过协议和领域校验、可以一次性写入 SessionStore 的完整逻辑段。
 */
export interface OutputSegmentMaterial {
  text: OutputSegmentTextMaterial;
  audio: OutputSegmentAudioMaterial;
  motion: OutputSegmentMotionMaterial;
}

/**
 * 后端轮次三段信号在前端的镜像。
 *   turnStarted     是否收到 turn_started
 *   synthFinished   是否收到 synth_finished
 *   turnFinished    是否收到 turn_finished
 *   success/reason  turn_finished 的成败与原因
 */
export interface TurnPlaybackSessionBackend {
  turnStarted: boolean;
  synthFinished: boolean;
  turnFinished: boolean;
  success: boolean | null;
  reason: string;
}

export interface TurnPlaybackSegment {
  id: string;
  messageId: string;
  turnId: string | null;
  text: TurnPlaybackSessionText;
  audio: TurnPlaybackSessionAudio;
  motion: TurnPlaybackSessionMotion;
}

export interface TurnPlaybackSession {
  id: string;
  turnId: string | null;
  interrupted: boolean;
  segments: Map<string, TurnPlaybackSegment>;
  segmentOrder: string[];
  backend: TurnPlaybackSessionBackend;
  phase: TurnPlaybackPhase;
}

// ── ID resolution ──────────────────────────────────────────────────

function normalizeId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 由 turnId 推导出稳定的会话 id；空 turnId 返回空串（调用方自行判错）。
 */
export function resolveSessionId(turnId: string | null): string {
  const normalizedTurn = normalizeId(turnId);
  if (normalizedTurn) {
    return `turn:${normalizedTurn}`;
  }
  return "";
}

// ── Constructors ───────────────────────────────────────────────────

export function createEmptyTextState(): TurnPlaybackSessionText {
  return {
    content: null,
    receivedAtMs: null,
    receiveMode: "replace",
    released: false,
    delivered: false,
    failed: false,
    reason: "",
  };
}

export function createEmptyAudioState(): TurnPlaybackSessionAudio {
  return {
    url: null,
    receivedAtMs: null,
    released: false,
    started: false,
    startedAtMs: null,
    durationMs: null,
    terminal: "idle",
    reason: "",
  };
}

export function createEmptyMotionState(): TurnPlaybackSessionMotion {
  return {
    payload: null,
    receivedAtMs: null,
    released: false,
    started: false,
    completed: false,
    absent: false,
    failed: false,
    reason: "",
  };
}

/**
 * 新建一份空白段（text/audio/motion 子状态都为初始值）。
 */
export function createTurnPlaybackSegment(
  messageId: string,
  turnId: string | null,
): TurnPlaybackSegment {
  return {
    id: messageId,
    messageId,
    turnId,
    text: createEmptyTextState(),
    audio: createEmptyAudioState(),
    motion: createEmptyMotionState(),
  };
}

/**
 * 新建一份空白会话；turnId 为空时直接抛错（无法解析 sessionId）。
 * 初始 phase = collecting，segments 为空 Map。
 */
export function createTurnPlaybackSession(
  turnId: string | null = null,
): TurnPlaybackSession {
  const sessionId = resolveSessionId(turnId);
  if (!sessionId) {
    throw new Error("Turn playback session requires turnId.");
  }
  return {
    id: sessionId,
    turnId,
    interrupted: false,
    segments: new Map(),
    segmentOrder: [],
    backend: {
      turnStarted: false,
      synthFinished: false,
      turnFinished: false,
      success: null,
      reason: "",
    },
    phase: "collecting",
  };
}

/**
 * 段是否已经本地结算：text 已 delivered、audio 已到终态、motion 已 absent/completed/failed
 * 三者之一。注意不读 backend.*，仅看本段三个子状态。
 */
export function isSegmentLocallySettled(segment: TurnPlaybackSegment): boolean {
  if (!segment.text.delivered) {
    return false;
  }
  const terminal = segment.audio.terminal;
  if (terminal !== "completed" && terminal !== "failed" && terminal !== "absent") {
    return false;
  }
  if (!segment.motion.absent && !segment.motion.completed && !segment.motion.failed) {
    return false;
  }
  return true;
}
