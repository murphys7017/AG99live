/**
 * 适配器出站动作集合。
 *
 * 集中放"前端 → 后端"方向上的业务级请求。用户触发的 action 通常遵循：
 * 检查 outboundClient.canSend → 维护本地轮次/播放状态 → 调用
 * outboundClient.send(type, payload, turnId) 发一条消息 → 写回 state.statusMessage
 * 与历史记录。少数底层回执 helper（如 playback_finished）只负责协议发送。
 * 底层 WebSocket 框架由 outboundClient.ts 负责，本文件只决定"在什么时机发什么消息"。
 *
 * 边界：
 *   - 不直接持有 WebSocket，统一通过 OutboundActionContext.outboundClient 发送。
 *   - 不接收入站消息，入站走 inbound/ 分支。
 *   - 任何业务级停播都走 ctx.stopAudioAndSettleTurn，由它先把段终态写回再停播。
 */

import type { SystemSemanticAxisProfileSavePayload } from "../../types/protocol.js";
import {
  normalizeTurnIdForComparison,
} from "../core/turnIds.js";
import type { AdapterOutboundClient } from "./outboundClient.js";

export interface MotionLabRawEventPayload {
  event_id: string;
  event_type: string;
  message_id?: string;
  source_route?: string;
  phase?: string;
  model_name?: string;
  profile_id?: string;
  profile_revision?: number;
  assistant_text?: string;
  payload_kind?: string;
  raw: Record<string, unknown>;
}

/**
 * 出站动作共享的轻量状态视图。
 *
 * 由 useAdapterConnection 持有真实对象，函数只读取/写回，不创建新实例。
 */
export interface OutboundActionState {
  currentTurnId: string | null;
  desktopScreenshotOnSendEnabled: boolean;
  lastError: string;
  statusMessage: string;
}

/**
 * 出站动作执行上下文。
 *
 * 把发消息所需的“连接、状态、UI 副作用、ID 工厂”聚合成一个参数，避免每个 action
 * 单独维护一长串依赖。stopAudioAndSettleTurn 是收口入口：任何业务级停播都必须经过它，
 * 不应直接调用底层 stopAudioPlayback。
 */
export interface OutboundActionContext {
  state: OutboundActionState;
  outboundClient: AdapterOutboundClient;
  pushHistory: (role: string, text: string) => void;
  stopAudioAndSettleTurn: (turnId: string | null, reason: string) => void;
  findOpenAudioSegment: () => { turnId: string | null; messageId: string } | null;
  findOpenExecutionSegment: () => { turnId: string | null; messageId: string } | null;
  markTurnInterrupted: (turnId: string | null) => void;
  createMessageId: () => string;
}

interface DesktopCaptureImagePayload {
  data: string;
  mime_type: "image/jpeg";
  source: "screen";
  captured_at: string;
}

/**
 * 发送文本输入到 AstrBot 适配器，开启新一轮对话。
 *
 * 行为：
 *   1. 为新一轮分配新的 turn_id（与 messageId 同体）。
 *   2. 若用户启用了“发送时附带桌面截图”，调用 Electron preload 抓一张 JPEG，
 *      失败时静默回退到纯文本（截图能力不可用不应阻断发消息）。
 *   3. 发送 `input.text` 信封，同步更新 statusMessage / 历史记录。
 *
 * 新输入与用户主动中断是两个独立操作。旧轮的播放和终态继续由 Timeline 管理，
 * 本函数不得发送 `control.interrupt` 或修改旧播放段。
 *
 * 返回 true 表示信封已成功投递到底层 WebSocket（不代表后端已确认）。
 */
export async function sendText(ctx: OutboundActionContext, text: string): Promise<boolean> {
  const message = text.trim();
  if (!message || !ctx.outboundClient.canSend()) {
    ctx.state.lastError = "当前还没有连上适配器，文本未发送。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }

  const desktopCapture = ctx.state.desktopScreenshotOnSendEnabled
    ? await captureRealtimeDesktopScreenshot()
    : null;
  const turnId = ctx.createMessageId();
  const outboundText = buildDesktopAwareText(message, desktopCapture);
  const sent = ctx.outboundClient.send("input.text", {
    text: outboundText,
    images: desktopCapture ? [desktopCapture] : [],
  }, turnId);
  if (!sent) {
    ctx.state.lastError = "当前还没有连上适配器，文本未发送。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }
  ctx.state.currentTurnId = turnId;
  ctx.state.lastError = "";
  ctx.state.statusMessage = desktopCapture
    ? "文本和实时桌面截图已发送，等待后端回复。"
    : "文本已发送，等待后端回复。";
  ctx.pushHistory("user", message);
  return true;
}

function getInterruptibleTurnId(ctx: OutboundActionContext): string | null {
  const openAudioTurnId = normalizeTurnIdForComparison(
    ctx.findOpenAudioSegment()?.turnId ?? null,
  );
  if (openAudioTurnId) {
    return openAudioTurnId;
  }
  const openExecutionTurnId = normalizeTurnIdForComparison(
    ctx.findOpenExecutionSegment()?.turnId ?? null,
  );
  if (openExecutionTurnId) {
    return openExecutionTurnId;
  }
  return normalizeTurnIdForComparison(ctx.state.currentTurnId);
}

async function captureRealtimeDesktopScreenshot(): Promise<DesktopCaptureImagePayload | null> {
  const captureDesktopScreenshot = window.ag99desktop?.captureDesktopScreenshot;
  if (!captureDesktopScreenshot) {
    return null;
  }

  try {
    const result = await captureDesktopScreenshot();
    return result ?? null;
  } catch (error) {
    console.warn("[DesktopCapture] Failed to capture realtime desktop screenshot", error);
    return null;
  }
}

function buildDesktopAwareText(
  message: string,
  desktopCapture: DesktopCaptureImagePayload | null,
): string {
  if (!desktopCapture) {
    return message;
  }

  return [
    "[系统上下文]",
    "以下附件中包含用户发送本条消息时的实时桌面截图。",
    `截图时间：${desktopCapture.captured_at}`,
    "请结合用户文字与截图中的桌面界面内容理解上下文，再进行回应。",
    "[/系统上下文]",
    "",
    "用户消息：",
    message,
  ].join("\n");
}

/**
 * 用户主动打断当前轮次。
 *
 * 先在本地把活跃音频段就地标 failed 并停播（reason=audio_playback_interrupted），
 * 再向后端发送 `control.interrupt`。本地清理与协议发送顺序固定，保证 UI 立即响应，
 * 即使后端 ACK 慢也不会出现“点了中断仍在说话”的状态。
 */
export function interruptCurrentTurn(ctx: OutboundActionContext): boolean {
  if (!ctx.outboundClient.canSend()) {
    ctx.state.lastError = "当前还没有连上适配器，无法发送中断。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }

  const interruptTurnId =
    getInterruptibleTurnId(ctx)
    ?? ctx.state.currentTurnId
    ?? null;
  if (!interruptTurnId) {
    ctx.state.lastError = "当前没有可中断的轮次。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }

  ctx.stopAudioAndSettleTurn(interruptTurnId, "audio_playback_interrupted");

  if (!ctx.outboundClient.send("control.interrupt", {}, interruptTurnId)) {
    ctx.state.lastError = "当前还没有连上适配器，无法发送中断。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }
  ctx.markTurnInterrupted(interruptTurnId);
  ctx.state.statusMessage = "已发送中断请求。";
  ctx.pushHistory("system", ctx.state.statusMessage);
  return true;
}

/**
 * 把档案编辑器整理好的语义轴档案保存到后端。
 *
 * 走 `system.semantic_axis_profile_save`，由后端落盘并广播 saved/save_failed 回执。
 * 不属于对话轮次，因此不携带 turn_id。
 */
export function sendSemanticAxisProfileSave(
  ctx: OutboundActionContext,
  payload: SystemSemanticAxisProfileSavePayload,
): boolean {
  if (!ctx.outboundClient.canSend()) {
    ctx.state.lastError = "当前还没有连上适配器，无法保存主轴配置。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }

  if (!ctx.outboundClient.send("system.semantic_axis_profile_save", payload)) {
    ctx.state.lastError = "当前还没有连上适配器，无法保存主轴配置。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }
  ctx.state.lastError = "";
  ctx.state.statusMessage = `已提交模型 ${payload.model_name} 的主轴配置保存请求。`;
  ctx.pushHistory("system", ctx.state.statusMessage);
  return true;
}

/**
 * 发 `control.playback_finished`，向后端报告本轮播放结果。
 *
 * success/reason 透传到 payload；reason 只在非空时才写入，避免被后端 payload 校验拒收。
 * 本函数不检查连接状态，由调用方保证；不触碰本地播放状态，纯协议发送。
 */
export function sendPlaybackFinished(
  ctx: OutboundActionContext,
  turnId: string | null,
  success: boolean,
  reason?: string,
): boolean {
  const payload: { success: boolean; reason?: string } = { success };
  if (reason) {
    payload.reason = reason;
  }

  return ctx.outboundClient.send("control.playback_finished", payload, turnId);
}

export function sendMotionLabRawEvent(
  ctx: OutboundActionContext,
  payload: MotionLabRawEventPayload,
  turnId?: string | null,
): boolean {
  if (!ctx.outboundClient.canSend()) {
    return false;
  }
  return ctx.outboundClient.send("system.motion_lab_raw_event", payload, turnId);
}

/**
 * 收到 turn_finished 之后清理与该 turn 关联的播放组上下文。
 *
 * 三件事：若该 turn 仍是活跃音频归属，调用 stopAudioAndSettleTurn 写回段终态并停播；
 * 若该 turn 还是 currentTurnId，置空。音频与动作终态由 Timeline/Session 持有。
 * 不发协议消息，纯本地状态清理。
 */
export function clearPlaybackGroupContext(
  ctx: OutboundActionContext,
  turnId: string | null,
): void {
  const normalizedTurnId = normalizeTurnIdForComparison(turnId);
  const normalizedCurrentTurnId = normalizeTurnIdForComparison(ctx.state.currentTurnId);
  const matchesActiveGroup = Boolean(
    normalizedTurnId
    && normalizedCurrentTurnId
    && normalizedTurnId === normalizedCurrentTurnId,
  );

  const matchesOpenAudio = normalizeTurnIdForComparison(
    ctx.findOpenAudioSegment()?.turnId ?? null,
  ) === normalizedTurnId;
  if (matchesOpenAudio) {
    ctx.stopAudioAndSettleTurn(turnId, "playback_group_cleared");
  }

  if (matchesActiveGroup) {
    ctx.state.currentTurnId = null;
  }

}
