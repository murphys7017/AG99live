import { reactive } from "vue";
import { BilibiliLiveClient } from "./bilibiliLiveClient.js";
import {
  DEFAULT_BILIBILI_LIVE_STATUS,
  type BilibiliDanmakuMessage,
  type BilibiliLiveSettings,
  type BilibiliLiveStatus,
} from "../types/bilibili-live.js";
import {
  loadBilibiliLiveSettings,
  normalizeBilibiliLiveSettings,
  saveBilibiliLiveSettings,
} from "./settings.js";

const TICK_MS = 1_000;
const MAX_BATCH_SIZE = 8;
const MAX_BUFFER_SIZE = 80;

interface BilibiliLiveRuntimeOptions {
  sendText: (text: string) => Promise<boolean>;
  pushHistory: (role: "system" | "error", text: string) => void;
  onStatusChanged?: () => void;
}

export function useBilibiliLiveRuntime(options: BilibiliLiveRuntimeOptions) {
  const settings = reactive<BilibiliLiveSettings>(loadBilibiliLiveSettings());
  const status = reactive<BilibiliLiveStatus>({
    ...DEFAULT_BILIBILI_LIVE_STATUS,
    enabled: settings.enabled,
    roomId: settings.roomId,
    hasCookie: Boolean(settings.cookie),
    status: settings.enabled ? "idle" : "disabled",
  });
  const buffer: BilibiliDanmakuMessage[] = [];

  let client: BilibiliLiveClient | null = null;
  let tickTimer: number | null = null;
  let lastFlushAt = Date.now();
  let sending = false;
  let generation = 0;

  function start(): void {
    ensureTickTimer();
    applySettings(settings);
  }

  function dispose(): void {
    generation += 1;
    stopClient();
    clearTickTimer();
    buffer.splice(0);
  }

  function applySettings(nextSettings: BilibiliLiveSettings): void {
    const normalized = normalizeBilibiliLiveSettings(nextSettings);
    Object.assign(settings, normalized);
    saveBilibiliLiveSettings(normalized);
    syncStatusFromSettings();
    buffer.splice(0);
    lastFlushAt = Date.now();

    generation += 1;
    const activeGeneration = generation;
    stopClient();
    if (!normalized.enabled) {
      status.status = "disabled";
      status.connected = false;
      status.bufferedCount = 0;
      status.realRoomId = null;
      notifyStatusChanged();
      return;
    }
    if (!normalized.roomId) {
      status.status = "error";
      status.lastError = "请输入 B 站直播间房间 ID。";
      notifyStatusChanged();
      return;
    }

    status.status = "connecting";
    status.lastError = "";
    client = new BilibiliLiveClient({
      settings: normalized,
      onDanmaku: (message) => {
        if (activeGeneration !== generation) {
          return;
        }
        handleDanmaku(message);
      },
      onStatus: (nextStatus) => {
        if (activeGeneration !== generation) {
          return;
        }
        status.connected = nextStatus.connected;
        status.realRoomId = nextStatus.realRoomId;
        status.lastError = nextStatus.lastError;
        status.authReceived = Boolean(nextStatus.authReceived);
        status.heartbeatReceived = Boolean(nextStatus.heartbeatReceived);
        status.commandCount = Math.max(0, Math.round(nextStatus.commandCount ?? 0));
        status.danmakuCount = Math.max(0, Math.round(nextStatus.danmakuCount ?? 0));
        status.lastCommand = nextStatus.lastCommand ?? "";
        status.protover = nextStatus.protover ?? null;
        status.status = nextStatus.connected
          ? "connected"
          : nextStatus.lastError
            ? "error"
            : "connecting";
        notifyStatusChanged();
      },
    });
    client.start();
    notifyStatusChanged();
  }

  function getSettings(): BilibiliLiveSettings {
    return { ...settings };
  }

  function getStatus(): BilibiliLiveStatus {
    return { ...status };
  }

  function handleDanmaku(message: BilibiliDanmakuMessage): void {
    buffer.push(message);
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
    }
    status.bufferedCount = buffer.length;
    status.lastMessageAt = new Date(message.timestamp).toISOString();
    notifyStatusChanged();
  }

  function ensureTickTimer(): void {
    if (tickTimer !== null) {
      return;
    }
    tickTimer = window.setInterval(() => {
      void flushIfReady();
    }, TICK_MS);
  }

  async function flushIfReady(): Promise<void> {
    if (!settings.enabled || sending || buffer.length === 0) {
      return;
    }
    if (Date.now() - lastFlushAt < settings.responseIntervalSeconds * 1000) {
      return;
    }

    const batch = buffer.splice(0, MAX_BATCH_SIZE);
    status.bufferedCount = buffer.length;
    lastFlushAt = Date.now();
    sending = true;
    try {
      const sent = await options.sendText(formatDanmakuBatch(batch));
      if (!sent) {
        buffer.unshift(...batch);
        status.bufferedCount = buffer.length;
        status.lastError = "弹幕输入发送失败，等待下一轮重试。";
        status.status = "error";
      } else {
        status.lastError = "";
        status.status = status.connected ? "connected" : status.status;
        options.pushHistory("system", `已提交 ${batch.length} 条直播弹幕给对话链路。`);
      }
    } catch (error) {
      buffer.unshift(...batch);
      status.bufferedCount = buffer.length;
      status.lastError = error instanceof Error ? error.message : "弹幕输入发送失败。";
      status.status = "error";
    } finally {
      sending = false;
      notifyStatusChanged();
    }
  }

  function stopClient(): void {
    client?.stop();
    client = null;
  }

  function clearTickTimer(): void {
    if (tickTimer === null) {
      return;
    }
    window.clearInterval(tickTimer);
    tickTimer = null;
  }

  function syncStatusFromSettings(): void {
    status.enabled = settings.enabled;
    status.roomId = settings.roomId;
    status.hasCookie = Boolean(settings.cookie);
    status.bufferedCount = buffer.length;
  }

  function notifyStatusChanged(): void {
    options.onStatusChanged?.();
  }

  return {
    settings,
    status,
    start,
    dispose,
    applySettings,
    getSettings,
    getStatus,
  };
}

function formatDanmakuBatch(messages: readonly BilibiliDanmakuMessage[]): string {
  const lines = messages.map((message) =>
    `- ${sanitizeInlineText(message.uname || "观众")}：${sanitizeInlineText(message.text)}`,
  );
  return [
    "[直播弹幕输入]",
    "直播间观众刚刚说：",
    ...lines,
    "",
    "请以桌宠/主播搭档身份自然回应直播间观众。优先回应其中有意思或适合互动的内容，保持简短，不要逐条机械复读。",
  ].join("\n");
}

function sanitizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

