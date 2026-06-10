import type { SystemSemanticAxisProfileSavePayload } from "../../types/protocol.js";
import {
  normalizeTurnIdForComparison,
} from "../core/turnIds.js";
import type {
  PendingAssistantTextItem,
  PendingAudioItem,
} from "../runtime/playbackReleaseQueue.js";
import type { AdapterOutboundClient } from "./outboundClient.js";

export interface OutboundActionState {
  currentTurnId: string | null;
  isPlayingAudio: boolean;
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackTerminalTurnId: string | null;
  pendingAssistantTexts: Map<string, PendingAssistantTextItem>;
  pendingAudios: Map<string, PendingAudioItem>;
  desktopScreenshotOnSendEnabled: boolean;
  lastError: string;
  statusMessage: string;
}

export interface OutboundActionContext {
  state: OutboundActionState;
  outboundClient: AdapterOutboundClient;
  pushHistory: (role: string, text: string) => void;
  stopAudio: () => void;
  stopAudioAndSettleCurrent: (reason: string) => void;
  resetAudioPlaybackTerminal: () => void;
  createMessageId: () => string;
}

interface DesktopCaptureImagePayload {
  data: string;
  mime_type: "image/jpeg";
  source: "screen";
  captured_at: string;
}

export async function sendText(ctx: OutboundActionContext, text: string): Promise<boolean> {
  const message = text.trim();
  if (!message || !ctx.outboundClient.canSend()) {
    ctx.state.lastError = "当前还没有连上适配器，文本未发送。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }

  const interruptedTurnId = getInterruptibleTurnId(ctx.state);
  if (interruptedTurnId) {
    ctx.outboundClient.send("control.interrupt", {}, interruptedTurnId);
    ctx.stopAudioAndSettleCurrent("audio_playback_replaced_by_new_input");
  }
  ctx.state.currentTurnId = ctx.createMessageId();
  ctx.resetAudioPlaybackTerminal();
  const desktopCapture = ctx.state.desktopScreenshotOnSendEnabled
    ? await captureRealtimeDesktopScreenshot()
    : null;
  const outboundText = buildDesktopAwareText(message, desktopCapture);
  const sent = ctx.outboundClient.send("input.text", {
    text: outboundText,
    images: desktopCapture ? [desktopCapture] : [],
  }, ctx.state.currentTurnId);
  if (!sent) {
    ctx.state.lastError = "当前还没有连上适配器，文本未发送。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }
  ctx.state.lastError = "";
  ctx.state.statusMessage = desktopCapture
    ? "文本和实时桌面截图已发送，等待后端回复。"
    : "文本已发送，等待后端回复。";
  ctx.pushHistory("user", message);
  return true;
}

function getInterruptibleTurnId(state: OutboundActionState): string | null {
  const currentTurnId = normalizeTurnIdForComparison(state.currentTurnId);
  const activeAudioTurnId = normalizeTurnIdForComparison(state.audioPlaybackStartedTurnId);
  if (activeAudioTurnId && (!currentTurnId || activeAudioTurnId === currentTurnId)) {
    return activeAudioTurnId;
  }

  if (!currentTurnId) {
    return null;
  }

  if (state.isPlayingAudio) {
    return currentTurnId;
  }
  if (hasPendingPlaybackForTurn(state.pendingAssistantTexts, currentTurnId)) {
    return currentTurnId;
  }
  if (hasPendingPlaybackForTurn(state.pendingAudios, currentTurnId)) {
    return currentTurnId;
  }
  return null;
}

function hasPendingPlaybackForTurn(
  pendingItems: Map<string, { turnId: string | null }>,
  turnId: string,
): boolean {
  for (const item of pendingItems.values()) {
    if (normalizeTurnIdForComparison(item.turnId) === turnId) {
      return true;
    }
  }
  return false;
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

export function interruptCurrentTurn(ctx: OutboundActionContext): boolean {
  if (!ctx.outboundClient.canSend()) {
    ctx.state.lastError = "当前还没有连上适配器，无法发送中断。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }

  ctx.stopAudioAndSettleCurrent("audio_playback_interrupted");
  ctx.resetAudioPlaybackTerminal();

  if (!ctx.outboundClient.send("control.interrupt", {}, ctx.state.currentTurnId)) {
    ctx.state.lastError = "当前还没有连上适配器，无法发送中断。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }
  ctx.state.statusMessage = "已发送中断请求。";
  ctx.pushHistory("system", ctx.state.statusMessage);
  return true;
}

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

export function sendMotionPayloadPreview(
  ctx: OutboundActionContext,
  payload: unknown,
  supportedMotionIntentSchemas: readonly string[],
): boolean {
  if (!ctx.outboundClient.canSend()) {
    ctx.state.lastError = "当前还没有连上适配器，无法发送动作测试载荷。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }

  const schemaVersion = payload && typeof payload === "object"
    ? String((payload as Record<string, unknown>).schema_version ?? "").trim()
    : "";
  if (!supportedMotionIntentSchemas.includes(schemaVersion)) {
    ctx.state.lastError = `动作测试载荷无效：不支持 schema_version=${schemaVersion || "empty"}。`;
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    console.warn("[Connection] refusing invalid motion preview payload:", payload);
    return false;
  }

  if (!ctx.outboundClient.send("engine.motion_intent", {
    mode: "preview",
    intent: payload,
  })) {
    ctx.state.lastError = "当前还没有连上适配器，无法发送动作测试载荷。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }
  ctx.state.statusMessage = "已发送动作测试载荷（engine.motion_intent）。";
  ctx.pushHistory("system", ctx.state.statusMessage);
  return true;
}

export function sendPlaybackFinished(
  ctx: OutboundActionContext,
  turnId: string | null,
  success: boolean,
  reason?: string,
): void {
  const payload: { success: boolean; reason?: string } = { success };
  if (reason) {
    payload.reason = reason;
  }

  ctx.outboundClient.send("control.playback_finished", payload, turnId);
}

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

  if (matchesActiveGroup) {
    ctx.state.currentTurnId = null;
  }

  const matchesStartedAudio = normalizeTurnIdForComparison(ctx.state.audioPlaybackStartedTurnId) === normalizedTurnId;
  if (matchesStartedAudio) {
    ctx.stopAudio();
  }

  const matchesTerminalAudio =
    normalizeTurnIdForComparison(ctx.state.audioPlaybackTerminalTurnId) === normalizedTurnId;
  if (matchesTerminalAudio || matchesStartedAudio || matchesActiveGroup) {
    ctx.resetAudioPlaybackTerminal();
  }
}
