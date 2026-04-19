import { reactive, readonly } from "vue";
import type { DesktopHistoryEntry } from "../types/desktop";
import type {
  ControlErrorPayload,
  ControlPlaybackFinishedPayload,
  ControlTurnFinishedPayload,
  ModelSyncInfo,
  OutputAudioPayload,
  OutputImagePayload,
  OutputTextPayload,
  OutputTranscriptionPayload,
  ProtocolEnvelope,
  SystemModelSyncPayload,
  SystemServerInfoPayload,
} from "../types/protocol";
import { useModelSync } from "./useModelSync";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

const DEFAULT_ADAPTER_ADDRESS = "127.0.0.1:12396";
const ADDRESS_STORAGE_KEY = "ag99live.adapter.address";
const LEGACY_ADDRESS_STORAGE_KEY = "ag99live.adapter.ws_address";
const PROTOCOL_VERSION = "v2";
const SOURCE_FRONTEND = "frontend";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

const state = reactive({
  address: loadStoredAddress(),
  sessionId: "",
  status: "disconnected" as ConnectionStatus,
  statusMessage: "尚未连接适配器。",
  serverInfo: null as SystemServerInfoPayload | null,
  activeWsAddress: "",
  lastError: "",
  lastAssistantText: "",
  lastTranscription: "",
  lastImageCount: 0,
  currentTurnId: null as string | null,
  micRequested: false,
  isPlayingAudio: false,
  historyEntries: [] as DesktopHistoryEntry[],
});

let socket: WebSocket | null = null;
let audioElement: HTMLAudioElement | null = null;
let manualClose = false;
let initializePromise: Promise<void> | null = null;
let connectAttemptSerial = 0;
const assistantHistoryKeys: string[] = [];
const assistantHistoryKeySet = new Set<string>();

const { applyUnknownMessage, resetModelSyncState } = useModelSync();

function loadStoredAddress(): string {
  if (typeof window === "undefined") {
    return DEFAULT_ADAPTER_ADDRESS;
  }

  const storedAddress = window.localStorage.getItem(ADDRESS_STORAGE_KEY);
  if (storedAddress?.trim()) {
    return storedAddress.trim();
  }

  const legacyAddress = window.localStorage.getItem(LEGACY_ADDRESS_STORAGE_KEY);
  if (legacyAddress?.trim()) {
    return legacyAddress.trim();
  }

  return DEFAULT_ADAPTER_ADDRESS;
}

function buildMessageEnvelope<TPayload>(
  type: string,
  payload: TPayload,
  turnId: string | null = null,
): ProtocolEnvelope<TPayload> {
  return {
    type,
    version: PROTOCOL_VERSION,
    message_id: createMessageId(),
    timestamp: new Date().toISOString(),
    session_id: state.sessionId || "desktop-client",
    turn_id: turnId,
    source: SOURCE_FRONTEND,
    payload,
  };
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

function normalizeWsAddress(raw: string): string {
  const trimmed = raw.trim();
  const candidate = trimmed || DEFAULT_ADAPTER_ADDRESS;
  const prefixed = /^[a-z]+:\/\//i.test(candidate) ? candidate : `ws://${candidate}`;
  const url = new URL(prefixed);

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("连接地址必须是 ws://、wss://、http://、https:// 或主机名。");
  }

  if (!url.port) {
    url.port = "12396";
  }

  if (url.pathname === "/") {
    url.pathname = "";
  }

  return url.toString().replace(/\/$/, "");
}

function getLocalAdapterHosts(): string[] {
  const fallbackHosts = ["127.0.0.1", "localhost"];
  if (typeof window === "undefined") {
    return fallbackHosts;
  }
  const hosts = window.ag99desktop?.getLocalAdapterHosts?.() ?? fallbackHosts;
  const normalizedHosts: string[] = [];
  const seen = new Set<string>();

  for (const host of hosts) {
    const value = host.trim();
    if (!value) {
      continue;
    }

    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalizedHosts.push(value);
  }

  return normalizedHosts.length ? normalizedHosts : fallbackHosts;
}

function buildConnectionCandidates(raw: string): string[] {
  const primaryAddress = normalizeWsAddress(raw);
  const primaryUrl = new URL(primaryAddress);
  const candidates = [primaryAddress];

  if (!LOOPBACK_HOSTS.has(primaryUrl.hostname.toLowerCase())) {
    return candidates;
  }

  const seen = new Set(candidates);
  for (const host of getLocalAdapterHosts()) {
    const candidateUrl = new URL(primaryAddress);
    candidateUrl.hostname = host;
    const candidateAddress = candidateUrl.toString().replace(/\/$/, "");
    if (seen.has(candidateAddress)) {
      continue;
    }

    seen.add(candidateAddress);
    candidates.push(candidateAddress);
  }

  return candidates;
}

function formatAddressHost(address: string): string {
  try {
    return new URL(address).host;
  } catch (_error) {
    return address;
  }
}

function buildConnectFailureMessage(candidates: string[]): string {
  const labels = candidates.map((candidate) => formatAddressHost(candidate));
  return labels.length > 1
    ? `未能连接适配器，已尝试 ${labels.join(" / ")}。`
    : "WebSocket 连接异常，请检查地址和 AstrBot 插件状态。";
}

function persistAddress(nextAddress: string): void {
  const normalizedAddress = nextAddress.trim() || DEFAULT_ADAPTER_ADDRESS;
  state.address = normalizedAddress;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(ADDRESS_STORAGE_KEY, normalizedAddress);
    window.localStorage.removeItem(LEGACY_ADDRESS_STORAGE_KEY);
  }
}

function setAddress(nextAddress: string): void {
  persistAddress(nextAddress);
}

async function initialize(): Promise<void> {
  if (!initializePromise) {
    initializePromise = Promise.resolve().then(() => {
      const storedAddress = loadStoredAddress();
      if (storedAddress.trim()) {
        persistAddress(storedAddress);
      }
    });
  }

  await initializePromise;
}

function connect(): void {
  disconnectInternal(false);

  let candidates: string[] = [normalizeWsAddress(DEFAULT_ADAPTER_ADDRESS)];
  try {
    candidates = buildConnectionCandidates(state.address);
  } catch (error) {
    state.status = "error";
    state.lastError = error instanceof Error ? error.message : "连接地址格式无效。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return;
  }

  manualClose = false;
  state.status = "connecting";
  state.statusMessage = "正在连接适配器...";
  state.lastError = "";
  pushHistory("system", `开始连接 ${candidates[0]}`);

  const attemptSerial = ++connectAttemptSerial;
  openConnectionCandidate(candidates, 0, attemptSerial);
}

function disconnect(): void {
  const hadActiveSocket = Boolean(socket);
  disconnectInternal(true);
  state.status = "disconnected";
  state.statusMessage = "已断开适配器连接。";
  if (!hadActiveSocket) {
    pushHistory("system", state.statusMessage);
  }
}

function disconnectInternal(markManualClose: boolean): void {
  manualClose = markManualClose;
  connectAttemptSerial += 1;
  stopAudioPlayback();
  if (socket) {
    const currentSocket = socket;
    socket = null;
    currentSocket.close();
  }
}

function openConnectionCandidate(
  candidates: string[],
  index: number,
  attemptSerial: number,
): void {
  const targetAddress = candidates[index];
  const total = candidates.length;

  if (index > 0) {
    pushHistory("system", `尝试候选地址 ${targetAddress}`);
  }

  state.status = "connecting";
  state.statusMessage =
    total > 1
      ? `正在连接适配器 (${index + 1}/${total})...`
      : "正在连接适配器...";

  const nextSocket = new WebSocket(targetAddress);
  let opened = false;
  socket = nextSocket;

  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket || attemptSerial !== connectAttemptSerial) {
      nextSocket.close();
      return;
    }

    opened = true;
    persistAddress(state.address);
    state.activeWsAddress = targetAddress;
    state.status = "connected";
    state.statusMessage = "连接已建立，等待后端同步。";
    state.lastError = "";
    pushHistory("system", `已连接 ${targetAddress}`);
  });

  nextSocket.addEventListener("message", (event) => {
    void handleSocketMessage(event.data);
  });

  nextSocket.addEventListener("error", () => {
    if (socket !== nextSocket || attemptSerial !== connectAttemptSerial) {
      return;
    }

    if (!opened && index < candidates.length - 1) {
      state.statusMessage = `连接 ${formatAddressHost(targetAddress)} 失败，尝试下一个地址...`;
      socket = null;
      nextSocket.close();
      openConnectionCandidate(candidates, index + 1, attemptSerial);
      return;
    }

    state.status = "error";
    state.lastError = opened
      ? "WebSocket 连接异常，请检查地址和 AstrBot 插件状态。"
      : buildConnectFailureMessage(candidates);
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
  });

  nextSocket.addEventListener("close", () => {
    const isCurrentSocket = socket === nextSocket;
    const shouldHandleClose = isCurrentSocket || (socket === null && manualClose);
    if (!shouldHandleClose) {
      return;
    }

    if (isCurrentSocket) {
      socket = null;
    }

    if (
      !opened
      && !manualClose
      && attemptSerial === connectAttemptSerial
      && index < candidates.length - 1
    ) {
      openConnectionCandidate(candidates, index + 1, attemptSerial);
      return;
    }

    resetConnectionRuntimeState();

    if (manualClose) {
      state.status = "disconnected";
      state.statusMessage = "已断开适配器连接。";
      return;
    }

    if (!opened) {
      if (state.status !== "error") {
        state.status = "error";
        state.lastError = buildConnectFailureMessage(candidates);
        state.statusMessage = state.lastError;
        pushHistory("error", state.lastError);
      }
      return;
    }

    if (state.status !== "error") {
      state.status = "disconnected";
      state.statusMessage = "连接已关闭。";
      pushHistory("system", state.statusMessage);
    }
  });
}

function resetConnectionRuntimeState(): void {
  stopAudioPlayback();
  state.isPlayingAudio = false;
  state.currentTurnId = null;
  state.serverInfo = null;
  state.activeWsAddress = "";
  state.sessionId = "";
  state.micRequested = false;
  resetModelSyncState();
}

async function handleSocketMessage(rawData: string): Promise<void> {
  let envelope: ProtocolEnvelope<unknown>;
  try {
    envelope = JSON.parse(rawData) as ProtocolEnvelope<unknown>;
  } catch (_error) {
    state.lastError = "收到无法解析的后端消息。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return;
  }

  if (!envelope || typeof envelope !== "object" || typeof envelope.type !== "string") {
    state.lastError = "收到非法协议消息。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return;
  }

  if (typeof envelope.session_id === "string" && envelope.session_id.trim()) {
    state.sessionId = envelope.session_id.trim();
  }

  switch (envelope.type) {
    case "system.server_info":
      applyServerInfoMessage(envelope as ProtocolEnvelope<SystemServerInfoPayload>);
      return;
    case "system.model_sync":
      applyUnknownMessage(
        rewriteModelSyncEnvelope(envelope as ProtocolEnvelope<SystemModelSyncPayload>),
      );
      state.statusMessage = "模型能力已同步。";
      pushHistory("system", state.statusMessage);
      return;
    case "output.text":
      applyOutputText(envelope as ProtocolEnvelope<OutputTextPayload>);
      return;
    case "output.audio":
      await applyOutputAudio(envelope as ProtocolEnvelope<OutputAudioPayload>);
      return;
    case "output.image":
      applyOutputImage(envelope as ProtocolEnvelope<OutputImagePayload>);
      return;
    case "output.transcription":
      applyOutputTranscription(envelope as ProtocolEnvelope<OutputTranscriptionPayload>);
      return;
    case "control.turn_started":
      state.currentTurnId = envelope.turn_id;
      state.statusMessage = "后端正在处理这一轮对话。";
      pushHistory("system", state.statusMessage);
      return;
    case "control.turn_finished":
      applyTurnFinished(envelope as ProtocolEnvelope<ControlTurnFinishedPayload>);
      return;
    case "control.interrupt":
      stopAudioPlayback();
      state.isPlayingAudio = false;
      state.currentTurnId = null;
      state.statusMessage = "当前轮次已中断。";
      pushHistory("system", state.statusMessage);
      return;
    case "control.start_mic":
      state.micRequested = true;
      state.statusMessage = "后端请求启动麦克风，前端采集链路待接入。";
      pushHistory("system", state.statusMessage);
      return;
    case "control.synth_finished":
      state.statusMessage = state.isPlayingAudio ? "语音播放中..." : "语音合成已完成。";
      pushHistory("system", state.statusMessage);
      return;
    case "control.error":
      applyControlError(envelope as ProtocolEnvelope<ControlErrorPayload>);
      return;
    default:
      return;
  }
}

function applyServerInfoMessage(envelope: ProtocolEnvelope<SystemServerInfoPayload>): void {
  state.serverInfo = {
    ...envelope.payload,
    ws_url: rewriteSocketUrl(envelope.payload.ws_url),
    http_base_url: rewriteHttpUrl(envelope.payload.http_base_url),
  };
  state.micRequested = state.serverInfo.auto_start_mic;
  state.statusMessage = "适配器已连接，等待模型同步。";
  pushHistory("system", "收到后端运行信息。");
}

function applyOutputText(envelope: ProtocolEnvelope<OutputTextPayload>): void {
  const text = envelope.payload.text.trim();
  if (text) {
    updateAssistantText(text, envelope.turn_id);
  }
  state.lastError = "";
  state.statusMessage = "已收到文本回复。";
}

async function applyOutputAudio(envelope: ProtocolEnvelope<OutputAudioPayload>): Promise<void> {
  const { text, audio_url: audioUrl } = envelope.payload;
  if (text.trim()) {
    updateAssistantText(text.trim(), envelope.turn_id);
  }

  if (!audioUrl) {
    state.statusMessage = "收到音频回复占位，未提供可播放地址。";
    pushHistory("system", state.statusMessage);
    await sendPlaybackFinished(envelope.turn_id, false, "missing_audio_url");
    return;
  }

  await playAudioAndAcknowledge(rewriteHttpUrl(audioUrl), envelope.turn_id);
}

function applyOutputImage(envelope: ProtocolEnvelope<OutputImagePayload>): void {
  state.lastImageCount = envelope.payload.images.length;
  state.statusMessage = `收到 ${envelope.payload.images.length} 张图片回复。`;
  pushHistory("system", state.statusMessage);
}

function applyOutputTranscription(
  envelope: ProtocolEnvelope<OutputTranscriptionPayload>,
): void {
  const text = envelope.payload.text.trim();
  if (text) {
    state.lastTranscription = text;
    state.statusMessage = "已收到语音转写。";
    pushHistory("transcription", text);
  }
}

function applyTurnFinished(
  envelope: ProtocolEnvelope<ControlTurnFinishedPayload>,
): void {
  if (!state.isPlayingAudio) {
    state.currentTurnId = null;
  }

  if (envelope.payload.success) {
    state.statusMessage = "本轮对话已完成。";
    state.lastError = "";
    pushHistory("system", state.statusMessage);
    return;
  }

  state.statusMessage = envelope.payload.reason
    ? `本轮结束：${envelope.payload.reason}`
    : "本轮对话未正常完成。";
  pushHistory("system", state.statusMessage);
}

function applyControlError(envelope: ProtocolEnvelope<ControlErrorPayload>): void {
  state.lastError = envelope.payload.message;
  state.statusMessage = envelope.payload.message;
  pushHistory("error", envelope.payload.message);
}

function updateAssistantText(text: string, turnId: string | null): void {
  state.lastAssistantText = text;

  if (!turnId) {
    pushHistory("assistant", text);
    return;
  }

  const dedupeKey = `${turnId}::${text}`;
  if (assistantHistoryKeySet.has(dedupeKey)) {
    return;
  }

  assistantHistoryKeySet.add(dedupeKey);
  assistantHistoryKeys.push(dedupeKey);
  if (assistantHistoryKeys.length > 120) {
    const expiredKey = assistantHistoryKeys.shift();
    if (expiredKey) {
      assistantHistoryKeySet.delete(expiredKey);
    }
  }

  pushHistory("assistant", text);
}

async function playAudioAndAcknowledge(
  audioUrl: string,
  turnId: string | null,
): Promise<void> {
  stopAudioPlayback();
  state.isPlayingAudio = true;
  state.statusMessage = "收到语音回复，正在播放。";
  pushHistory("system", state.statusMessage);

  const audio = new Audio(audioUrl);
  audioElement = audio;

  const cleanup = () => {
    if (audioElement === audio) {
      audioElement = null;
    }
  };

  audio.addEventListener(
    "ended",
    () => {
      cleanup();
      state.isPlayingAudio = false;
      state.currentTurnId = null;
      void sendPlaybackFinished(turnId, true);
    },
    { once: true },
  );

  audio.addEventListener(
    "error",
    () => {
      cleanup();
      state.isPlayingAudio = false;
      pushHistory("error", "音频播放失败。");
      void sendPlaybackFinished(turnId, false, "audio_playback_error");
    },
    { once: true },
  );

  try {
    await audio.play();
  } catch (error) {
    cleanup();
    state.isPlayingAudio = false;
    state.lastError =
      error instanceof Error ? error.message : "浏览器拒绝自动播放语音。";
    state.statusMessage = "语音播放失败，已回传结束状态。";
    pushHistory("error", state.statusMessage);
    await sendPlaybackFinished(turnId, false, "audio_autoplay_blocked");
  }
}

function stopAudioPlayback(): void {
  if (!audioElement) {
    return;
  }
  audioElement.pause();
  audioElement.currentTime = 0;
  audioElement = null;
}

function sendText(text: string): boolean {
  const message = text.trim();
  if (!message || !socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，文本未发送。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  const envelope = buildMessageEnvelope("input.text", {
    text: message,
    images: [],
  });
  socket.send(JSON.stringify(envelope));
  state.lastError = "";
  state.statusMessage = "文本已发送，等待后端回复。";
  pushHistory("user", message);
  return true;
}

function interruptCurrentTurn(): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，无法发送中断。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  stopAudioPlayback();
  state.isPlayingAudio = false;

  const envelope = buildMessageEnvelope("control.interrupt", {}, state.currentTurnId);
  socket.send(JSON.stringify(envelope));
  state.statusMessage = "已发送中断请求。";
  pushHistory("system", state.statusMessage);
  return true;
}

async function sendPlaybackFinished(
  turnId: string | null,
  success: boolean,
  reason?: string,
): Promise<void> {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const payload: ControlPlaybackFinishedPayload = { success };
  if (reason) {
    payload.reason = reason;
  }

  socket.send(
    JSON.stringify(buildMessageEnvelope("control.playback_finished", payload, turnId)),
  );
}

function rewriteModelSyncEnvelope(
  envelope: ProtocolEnvelope<SystemModelSyncPayload>,
): ProtocolEnvelope<SystemModelSyncPayload> {
  const modelInfo = rewriteModelInfo(envelope.payload.model_info);
  return {
    ...envelope,
    payload: {
      ...envelope.payload,
      model_info: modelInfo,
    },
  };
}

function rewriteModelInfo(modelInfo: ModelSyncInfo): ModelSyncInfo {
  return {
    ...modelInfo,
    models: modelInfo.models.map((model) => ({
      ...model,
      model_url: rewriteHttpUrl(model.model_url),
      icon_url: rewriteHttpUrl(model.icon_url),
    })),
  };
}

function rewriteSocketUrl(rawUrl: string): string {
  return rewriteUrlWithConnectedHost(rawUrl, "ws");
}

function rewriteHttpUrl(rawUrl: string | null): string {
  if (!rawUrl) {
    return "";
  }
  return rewriteUrlWithConnectedHost(rawUrl, "http");
}

function rewriteUrlWithConnectedHost(
  rawUrl: string,
  family: "http" | "ws",
): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return trimmed;
  }

  const activeUrl = parseUrlSafely(state.activeWsAddress);
  const targetUrl = parseUrlSafely(trimmed);
  if (!activeUrl || !targetUrl) {
    return trimmed;
  }

  const rewritten = new URL(targetUrl.toString());
  rewritten.hostname = activeUrl.hostname;
  rewritten.protocol =
    family === "http"
      ? activeUrl.protocol === "wss:"
        ? "https:"
        : "http:"
      : activeUrl.protocol === "https:"
        ? "wss:"
        : activeUrl.protocol === "http:"
          ? "ws:"
          : activeUrl.protocol;

  if (activeUrl.username) {
    rewritten.username = activeUrl.username;
  }
  if (activeUrl.password) {
    rewritten.password = activeUrl.password;
  }

  return rewritten.toString().replace(/\/$/, "");
}

function parseUrlSafely(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch (_error) {
    return null;
  }
}

function pushHistory(role: DesktopHistoryEntry["role"], text: string): void {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return;
  }

  state.historyEntries.push({
    id: createMessageId(),
    role,
    text: normalizedText,
    timestamp: new Date().toISOString(),
  });

  if (state.historyEntries.length > 80) {
    state.historyEntries.splice(0, state.historyEntries.length - 80);
  }
}

export function useAdapterConnection() {
  return {
    state: readonly(state),
    initialize,
    setAddress,
    connect,
    disconnect,
    sendText,
    interruptCurrentTurn,
  };
}
