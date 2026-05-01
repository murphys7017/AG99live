import type { ProtocolEnvelope, SystemSemanticAxisProfileSavePayload } from "../types/protocol";

export interface OutboundActionState {
  currentTurnId: string | null;
  currentOrchestrationId: string | null;
  audioPlaybackStartedTurnId: string | null;
  audioPlaybackStartedOrchestrationId: string | null;
  desktopScreenshotOnSendEnabled: boolean;
  lastError: string;
  statusMessage: string;
}

export interface OutboundActionContext {
  state: OutboundActionState;
  getSocket: () => WebSocket | null;
  buildEnvelope: <TPayload>(
    type: string,
    payload: TPayload,
    turnId?: string | null,
    orchestrationId?: string | null,
  ) => ProtocolEnvelope<TPayload>;
  pushHistory: (role: string, text: string) => void;
  stopAudio: () => void;
  resetAudioPlaybackTerminal: () => void;
  createMessageId: () => string;
}

function normalizeTurnIdForComparison(turnId: string | null | undefined): string {
  return typeof turnId === "string" ? turnId.trim() : "";
}

function normalizeOrchestrationId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

interface DesktopCaptureImagePayload {
  data: string;
  mime_type: "image/jpeg";
  source: "screen";
  captured_at: string;
}

export async function sendText(ctx: OutboundActionContext, text: string): Promise<boolean> {
  const message = text.trim();
  const socket = ctx.getSocket();
  if (!message || !socket || socket.readyState !== WebSocket.OPEN) {
    ctx.state.lastError = "当前还没有连上适配器，文本未发送。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }

  ctx.state.currentOrchestrationId = ctx.createMessageId();
  ctx.state.currentTurnId = null;
  ctx.resetAudioPlaybackTerminal();
  const desktopCapture = ctx.state.desktopScreenshotOnSendEnabled
    ? await captureRealtimeDesktopScreenshot()
    : null;
  const outboundText = buildDesktopAwareText(message, desktopCapture);
  const envelope = ctx.buildEnvelope("input.text", {
    text: outboundText,
    images: desktopCapture ? [desktopCapture] : [],
  }, null, ctx.state.currentOrchestrationId);
  socket.send(JSON.stringify(envelope));
  ctx.state.lastError = "";
  ctx.state.statusMessage = desktopCapture
    ? "文本和实时桌面截图已发送，等待后端回复。"
    : "文本已发送，等待后端回复。";
  ctx.pushHistory("user", message);
  return true;
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
  const socket = ctx.getSocket();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    ctx.state.lastError = "当前还没有连上适配器，无法发送中断。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }

  ctx.stopAudio();
  ctx.resetAudioPlaybackTerminal();

  const envelope = ctx.buildEnvelope("control.interrupt", {}, ctx.state.currentTurnId);
  socket.send(JSON.stringify(envelope));
  ctx.state.statusMessage = "已发送中断请求。";
  ctx.pushHistory("system", ctx.state.statusMessage);
  return true;
}

export function sendSemanticAxisProfileSave(
  ctx: OutboundActionContext,
  payload: SystemSemanticAxisProfileSavePayload,
): boolean {
  const socket = ctx.getSocket();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    ctx.state.lastError = "当前还没有连上适配器，无法保存主轴配置。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }

  socket.send(
    JSON.stringify(
      ctx.buildEnvelope("system.semantic_axis_profile_save", payload),
    ),
  );
  ctx.state.lastError = "";
  ctx.state.statusMessage = `已提交模型 ${payload.model_name} 的主轴配置保存请求。`;
  ctx.pushHistory("system", ctx.state.statusMessage);
  return true;
}

export function sendMotionPayloadPreview(
  ctx: OutboundActionContext,
  payload: unknown,
  schemaMotionIntentV2: string,
  schemaParameterPlanV2: string,
): boolean {
  const socket = ctx.getSocket();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    ctx.state.lastError = "当前还没有连上适配器，无法发送动作测试载荷。";
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    return false;
  }

  const schemaVersion = payload && typeof payload === "object"
    ? String((payload as Record<string, unknown>).schema_version ?? "").trim()
    : "";
  if (
    schemaVersion !== schemaMotionIntentV2
    && schemaVersion !== schemaParameterPlanV2
  ) {
    ctx.state.lastError = `动作测试载荷无效：不支持 schema_version=${schemaVersion || "empty"}。`;
    ctx.state.statusMessage = ctx.state.lastError;
    ctx.pushHistory("error", ctx.state.lastError);
    console.warn("[Connection] refusing invalid motion preview payload:", payload);
    return false;
  }

  const messageType = schemaVersion === schemaMotionIntentV2
    ? "engine.motion_intent"
    : "engine.motion_plan";
  const payloadKey = messageType === "engine.motion_intent" ? "intent" : "plan";

  socket.send(
    JSON.stringify(
      ctx.buildEnvelope(messageType, {
        mode: "preview",
        [payloadKey]: payload,
      }),
    ),
  );
  ctx.state.statusMessage = `已发送动作测试载荷（${messageType}）。`;
  ctx.pushHistory("system", ctx.state.statusMessage);
  return true;
}

export function sendPlaybackFinished(
  ctx: OutboundActionContext,
  turnId: string | null,
  orchestrationId: string | null,
  success: boolean,
  reason?: string,
): void {
  const socket = ctx.getSocket();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const payload: { success: boolean; reason?: string } = { success };
  if (reason) {
    payload.reason = reason;
  }

  socket.send(
    JSON.stringify(
      ctx.buildEnvelope("control.playback_finished", payload, turnId, orchestrationId),
    ),
  );
}

export function clearPlaybackGroupContext(
  ctx: OutboundActionContext,
  turnId: string | null,
  orchestrationId: string | null,
): void {
  const normalizedTurnId = normalizeTurnIdForComparison(turnId);
  const normalizedCurrentTurnId = normalizeTurnIdForComparison(ctx.state.currentTurnId);
  const normalizedOrchestrationId = normalizeOrchestrationId(orchestrationId);
  const currentOrchestrationId = normalizeOrchestrationId(ctx.state.currentOrchestrationId);

  const matchesTurn = normalizedTurnId && normalizedCurrentTurnId && normalizedTurnId === normalizedCurrentTurnId;
  const matchesOrchestration =
    normalizedOrchestrationId
    && currentOrchestrationId
    && normalizedOrchestrationId === currentOrchestrationId;

  if (matchesTurn || matchesOrchestration) {
    ctx.state.currentTurnId = null;
    ctx.state.currentOrchestrationId = null;
  }

  if (
    normalizeTurnIdForComparison(ctx.state.audioPlaybackStartedTurnId) === normalizedTurnId
    || normalizeOrchestrationId(ctx.state.audioPlaybackStartedOrchestrationId) === normalizedOrchestrationId
  ) {
    ctx.stopAudio();
  }

  ctx.resetAudioPlaybackTerminal();
}
