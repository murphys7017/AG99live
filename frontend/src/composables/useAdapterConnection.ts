import { reactive, readonly } from "vue";
import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
  DesktopHistoryEntry,
  DesktopMotionTuningSamplesStatus,
  DesktopSemanticAxisProfileSaveResult,
  DesktopMotionTuningSample,
} from "../types/desktop";
import type {
  ControlErrorPayload,
  ControlPlaybackFinishedPayload,
  ControlTurnFinishedPayload,
  ModelSyncInfo,
  MotionTuningSampleProtocolPayload,
  OutputAudioPayload,
  OutputImagePayload,
  OutputTextPayload,
  OutputTranscriptionPayload,
  ProtocolEnvelope,
  RuntimeCacheErrorsPayload,
  SystemSemanticAxisProfileSavePayload,
  SystemSemanticAxisProfileSavedPayload,
  SystemSemanticAxisProfileSaveFailedPayload,
  SystemMotionTuningSampleDeletePayload,
  SystemMotionTuningSampleSavePayload,
  SystemMotionTuningSamplesStatePayload,
  SystemModelSyncPayload,
  SystemServerInfoPayload,
} from "../types/protocol";
import { useModelSync } from "./useModelSync";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

const DEFAULT_ADAPTER_ADDRESS = "127.0.0.1:12396";
const ADDRESS_STORAGE_KEY = "ag99live.adapter.address";
const LEGACY_ADDRESS_STORAGE_KEY = "ag99live.adapter.ws_address";
const DESKTOP_SCREENSHOT_ON_SEND_STORAGE_KEY = "ag99live.desktop.capture_on_send";
const PROTOCOL_VERSION = "v2";
const SOURCE_FRONTEND = "frontend";
const MIC_TARGET_SAMPLE_RATE = 16000;
const MIC_PROCESSOR_BUFFER_SIZE = 2048;
const MIC_AUDIO_WORKLET_PROCESSOR_NAME = "ag99live-microphone-capture";
const MIC_AUDIO_WORKLET_SOURCE = `
class Ag99liveMicrophoneCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    if (input && input.length > 0) {
      const chunk = new Float32Array(input.length);
      chunk.set(input);
      this.port.postMessage(chunk, [chunk.buffer]);
    }

    const output = outputs[0] && outputs[0][0];
    if (output) {
      output.fill(0);
    }
    return true;
  }
}

registerProcessor("${MIC_AUDIO_WORKLET_PROCESSOR_NAME}", Ag99liveMicrophoneCaptureProcessor);
`;
const MAX_MIC_SOCKET_BUFFERED_AMOUNT = 512 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

const state = reactive({
  address: loadStoredAddress(),
  desktopScreenshotOnSendEnabled: loadDesktopScreenshotOnSendEnabled(),
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
  micCapturing: false,
  isPlayingAudio: false,
  historyEntries: [] as DesktopHistoryEntry[],
  backendHistorySummaries: [] as DesktopBackendHistorySummary[],
  backendHistoryEntries: [] as DesktopBackendHistoryMessage[],
  activeBackendHistoryUid: "",
  backendHistoryLoading: false,
  backendHistoryStatusMessage: "等待历史窗口请求后端历史。",
  inboundMotionPlan: null as unknown | null,
  inboundMotionPlanNonce: 0,
  inboundMotionPlanTurnId: null as string | null,
  inboundMotionPlanReceivedAtMs: 0,
  audioPlaybackStartedNonce: 0,
  audioPlaybackStartedTurnId: null as string | null,
  audioPlaybackStartedAtMs: 0,
  audioPlaybackDurationMs: null as number | null,
  latestSemanticAxisProfileSaveResult: null as DesktopSemanticAxisProfileSaveResult | null,
  motionTuningSamples: [] as DesktopMotionTuningSample[],
  motionTuningSamplesStatus: {
    rootError: "",
    loadError: "",
    diagnostics: [],
  } as DesktopMotionTuningSamplesStatus,
});

interface MicrophoneCaptureRuntime {
  sampleRate: number;
  mediaStream: MediaStream;
  audioContext: AudioContext;
  sourceNode: MediaStreamAudioSourceNode;
  processorNode: AudioWorkletNode | ScriptProcessorNode;
  sinkGainNode: GainNode;
}

interface DesktopCaptureImagePayload {
  data: string;
  mime_type: "image/jpeg";
  source: "screen";
  captured_at: string;
}

interface SystemHistoryListPayload {
  histories: unknown[];
}

interface SystemHistoryCreatedPayload {
  history_uid: string;
}

interface SystemHistoryDataPayload {
  messages: unknown[];
}

interface SystemHistoryDeletedPayload {
  history_uid: string;
  success: boolean;
}

let socket: WebSocket | null = null;
let audioElement: HTMLAudioElement | null = null;
let manualClose = false;
let initializePromise: Promise<void> | null = null;
let connectAttemptSerial = 0;
let microphoneRuntime: MicrophoneCaptureRuntime | null = null;
let pendingHistoryLoadUid: string | null = null;
const assistantHistoryKeys: string[] = [];
const assistantHistoryKeySet = new Set<string>();
const reportedProtocolWarnings = new Set<string>();

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

function loadDesktopScreenshotOnSendEnabled(): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  const storedValue = window.localStorage.getItem(DESKTOP_SCREENSHOT_ON_SEND_STORAGE_KEY);
  if (storedValue === "false") {
    return false;
  }
  if (storedValue === "true") {
    return true;
  }
  return true;
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

function downsampleAudioBuffer(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate: number,
): Float32Array {
  if (!input.length || sourceSampleRate === targetSampleRate) {
    return input;
  }

  const sampleRateRatio = sourceSampleRate / targetSampleRate;
  const targetLength = Math.max(1, Math.round(input.length / sampleRateRatio));
  const output = new Float32Array(targetLength);
  let outputIndex = 0;
  let sourceOffset = 0;

  while (outputIndex < targetLength) {
    const nextSourceOffset = Math.round((outputIndex + 1) * sampleRateRatio);
    let accumulator = 0;
    let count = 0;

    for (let index = sourceOffset; index < Math.min(nextSourceOffset, input.length); index += 1) {
      accumulator += input[index] ?? 0;
      count += 1;
    }

    output[outputIndex] = count > 0 ? accumulator / count : 0;
    outputIndex += 1;
    sourceOffset = nextSourceOffset;
  }

  return output;
}

function serializeAudioChunk(audioBuffer: Float32Array): number[] {
  const serialized = new Array<number>(audioBuffer.length);
  for (let index = 0; index < audioBuffer.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, audioBuffer[index] ?? 0));
    serialized[index] = Math.round(sample * 10000) / 10000;
  }
  return serialized;
}

function sendMicrophoneAudioChunk(inputChunk: Float32Array, sourceSampleRate: number): void {
  if (
    !socket
    || socket.readyState !== WebSocket.OPEN
    || socket.bufferedAmount > MAX_MIC_SOCKET_BUFFERED_AMOUNT
  ) {
    return;
  }

  const normalizedChunk = downsampleAudioBuffer(
    inputChunk,
    sourceSampleRate,
    MIC_TARGET_SAMPLE_RATE,
  );
  if (!normalizedChunk.length) {
    return;
  }

  socket.send(
    JSON.stringify(
      buildMessageEnvelope("input.raw_audio_data", {
        audio: serializeAudioChunk(normalizedChunk),
        sample_rate: MIC_TARGET_SAMPLE_RATE,
        channels: 1,
      }),
    ),
  );
}

function isAudioWorkletNode(node: AudioNode): node is AudioWorkletNode {
  return "port" in node;
}

async function createMicrophoneProcessorNode(
  audioContext: AudioContext,
  onChunk: (inputChunk: Float32Array) => void,
): Promise<AudioWorkletNode | ScriptProcessorNode> {
  if (audioContext.audioWorklet && typeof AudioWorkletNode !== "undefined") {
    let moduleUrl = "";
    try {
      moduleUrl = URL.createObjectURL(
        new Blob([MIC_AUDIO_WORKLET_SOURCE], { type: "application/javascript" }),
      );
      await audioContext.audioWorklet.addModule(moduleUrl);
      const workletNode = new AudioWorkletNode(
        audioContext,
        MIC_AUDIO_WORKLET_PROCESSOR_NAME,
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        },
      );
      workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (event.data instanceof Float32Array) {
          onChunk(event.data);
        }
      };
      workletNode.port.onmessageerror = (event) => {
        console.warn("[Connection] microphone AudioWorklet message rejected.", event);
      };
      return workletNode;
    } catch (error) {
      console.warn(
        "[Connection] microphone AudioWorklet unavailable; falling back to deprecated ScriptProcessorNode.",
        error,
      );
    } finally {
      if (moduleUrl) {
        URL.revokeObjectURL(moduleUrl);
      }
    }
  }

  const scriptProcessorNode = audioContext.createScriptProcessor(
    MIC_PROCESSOR_BUFFER_SIZE,
    1,
    1,
  );
  scriptProcessorNode.onaudioprocess = (event) => {
    onChunk(event.inputBuffer.getChannelData(0));
  };
  return scriptProcessorNode;
}

function disconnectMicrophoneProcessorNode(
  processorNode: AudioWorkletNode | ScriptProcessorNode | null,
): void {
  if (!processorNode) {
    return;
  }

  if (isAudioWorkletNode(processorNode)) {
    processorNode.port.onmessage = null;
    processorNode.port.onmessageerror = null;
    processorNode.port.close();
  } else {
    processorNode.onaudioprocess = null;
  }
  processorNode.disconnect();
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }

  const maybeAudioContext = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return maybeAudioContext ?? null;
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

function setDesktopScreenshotOnSendEnabled(enabled: boolean): void {
  state.desktopScreenshotOnSendEnabled = enabled;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      DESKTOP_SCREENSHOT_ON_SEND_STORAGE_KEY,
      enabled ? "true" : "false",
    );
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
  void stopMicrophoneCapture(markManualClose ? "manual_disconnect" : "connection_reset");
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
  void stopMicrophoneCapture("connection_closed");
  stopAudioPlayback();
  pendingHistoryLoadUid = null;
  state.isPlayingAudio = false;
  state.currentTurnId = null;
  state.serverInfo = null;
  state.activeWsAddress = "";
  state.sessionId = "";
  state.micRequested = false;
  state.micCapturing = false;
  state.inboundMotionPlan = null;
  state.inboundMotionPlanNonce = 0;
  state.inboundMotionPlanTurnId = null;
  state.inboundMotionPlanReceivedAtMs = 0;
  state.audioPlaybackStartedNonce = 0;
  state.audioPlaybackStartedTurnId = null;
  state.audioPlaybackStartedAtMs = 0;
  state.audioPlaybackDurationMs = null;
  state.backendHistoryLoading = false;
  resetModelSyncState();
}

async function toggleMicrophoneCapture(): Promise<boolean> {
  if (state.micCapturing) {
    return stopMicrophoneCapture("manual_stop");
  }

  return startMicrophoneCapture();
}

async function startMicrophoneCapture(): Promise<boolean> {
  if (state.micCapturing) {
    return true;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，无法启动麦克风。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    state.lastError = "当前环境不支持麦克风采集。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) {
    state.lastError = "当前环境不支持 Web Audio API。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  state.statusMessage = "正在请求麦克风权限...";

  let mediaStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let processorNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  let sinkGainNode: GainNode | null = null;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: MIC_TARGET_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    audioContext = new AudioContextConstructor({
      latencyHint: "interactive",
      sampleRate: MIC_TARGET_SAMPLE_RATE,
    } as AudioContextOptions);
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sinkGainNode = audioContext.createGain();
    sinkGainNode.gain.value = 0;

    const sampleRate = Math.max(Math.round(audioContext.sampleRate || 16000), 1);
    processorNode = await createMicrophoneProcessorNode(
      audioContext,
      (inputChunk) => {
        const runtime = microphoneRuntime;
        if (!runtime) {
          return;
        }
        sendMicrophoneAudioChunk(inputChunk, runtime.sampleRate);
      },
    );

    microphoneRuntime = {
      sampleRate,
      mediaStream,
      audioContext,
      sourceNode,
      processorNode,
      sinkGainNode,
    };

    sourceNode.connect(processorNode);
    processorNode.connect(sinkGainNode);
    sinkGainNode.connect(audioContext.destination);

    for (const track of mediaStream.getAudioTracks()) {
      track.addEventListener(
        "ended",
        () => {
          void stopMicrophoneCapture("device_ended");
        },
        { once: true },
      );
    }

    state.micCapturing = true;
    state.micRequested = true;
    state.lastError = "";
    state.statusMessage = "麦克风已开启，正在自动检测说话。";
    pushHistory("system", state.statusMessage);
    return true;
  } catch (error) {
    sourceNode?.disconnect();
    disconnectMicrophoneProcessorNode(processorNode);
    sinkGainNode?.disconnect();
    mediaStream?.getTracks().forEach((track) => track.stop());
    if (audioContext) {
      try {
        await audioContext.close();
      } catch (_closeError) {
        // Ignore cleanup failures after startup errors.
      }
    }
    microphoneRuntime = null;
    state.micCapturing = false;
    state.lastError =
      error instanceof Error ? error.message : "麦克风启动失败。";
    state.statusMessage = `麦克风启动失败：${state.lastError}`;
    pushHistory("error", state.statusMessage);
    return false;
  }
}

async function stopMicrophoneCapture(reason = "manual_stop"): Promise<boolean> {
  const runtime = microphoneRuntime;
  if (!runtime) {
    state.micCapturing = false;
    if (reason === "manual_stop") {
      state.micRequested = false;
    }
    return false;
  }

  microphoneRuntime = null;
  state.micCapturing = false;
  if (reason === "manual_stop" || reason === "device_ended") {
    state.micRequested = false;
  }

  runtime.sourceNode.disconnect();
  disconnectMicrophoneProcessorNode(runtime.processorNode);
  runtime.sinkGainNode.disconnect();
  runtime.mediaStream.getTracks().forEach((track) => track.stop());

  try {
    await runtime.audioContext.close();
  } catch (_error) {
    // Ignore close failures during teardown.
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify(
        buildMessageEnvelope("input.mic_audio_end", {
          reason,
        }),
      ),
    );
  }

  state.statusMessage =
    reason === "manual_stop"
      ? "麦克风已关闭。"
      : "麦克风采集已停止。";
  if (reason !== "connection_closed" && reason !== "connection_reset") {
    pushHistory("system", state.statusMessage);
  }
  return true;
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

  const messageVersion =
    typeof envelope.version === "string"
      ? envelope.version.trim()
      : "";
  if (messageVersion !== PROTOCOL_VERSION) {
    reportProtocolError(
      `version:${messageVersion || "empty"}`,
      `收到协议版本不匹配的消息（expected=${PROTOCOL_VERSION}, actual=${messageVersion || "empty"}）。`,
      envelope,
    );
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
    case "system.semantic_axis_profile_saved":
      applySemanticAxisProfileSaved(
        envelope as ProtocolEnvelope<SystemSemanticAxisProfileSavedPayload>,
      );
      return;
    case "system.semantic_axis_profile_save_failed":
      applySemanticAxisProfileSaveFailed(
        envelope as ProtocolEnvelope<SystemSemanticAxisProfileSaveFailedPayload>,
      );
      return;
    case "system.motion_tuning_samples_state":
      applyMotionTuningSamplesState(
        envelope as ProtocolEnvelope<SystemMotionTuningSamplesStatePayload>,
      );
      return;
    case "system.history_list":
      applyHistoryList(envelope as ProtocolEnvelope<SystemHistoryListPayload>);
      return;
    case "system.history_created":
      applyHistoryCreated(envelope as ProtocolEnvelope<SystemHistoryCreatedPayload>);
      return;
    case "system.history_data":
      applyHistoryData(envelope as ProtocolEnvelope<SystemHistoryDataPayload>);
      return;
    case "system.history_deleted":
      applyHistoryDeleted(envelope as ProtocolEnvelope<SystemHistoryDeletedPayload>);
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
      state.statusMessage = "后端已请求启动麦克风，准备自动收音。";
      pushHistory("system", state.statusMessage);
      void startMicrophoneCapture();
      return;
    case "control.synth_finished":
      state.statusMessage = state.isPlayingAudio ? "语音播放中..." : "语音合成已完成。";
      pushHistory("system", state.statusMessage);
      return;
    case "control.error":
      applyControlError(envelope as ProtocolEnvelope<ControlErrorPayload>);
      return;
    case "engine.motion_plan":
    case "engine.motion_intent":
      applyInboundMotionPayload(envelope as ProtocolEnvelope<Record<string, unknown>>);
      return;
    default:
      reportUnhandledInboundEnvelope(envelope);
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
  if (state.serverInfo.auto_start_mic) {
    void startMicrophoneCapture();
  }
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

function applySemanticAxisProfileSaved(
  envelope: ProtocolEnvelope<SystemSemanticAxisProfileSavedPayload>,
): void {
  state.latestSemanticAxisProfileSaveResult = {
    requestId: envelope.payload.request_id,
    ok: true,
    modelName: envelope.payload.model_name,
    profileId: envelope.payload.profile_id,
    revision: envelope.payload.revision,
    sourceHash: envelope.payload.source_hash,
    savedAt: envelope.payload.saved_at,
    receivedAt: new Date().toISOString(),
  };
  state.lastError = "";
  state.statusMessage = `主轴配置已保存到 revision ${envelope.payload.revision}。`;
  pushHistory("system", state.statusMessage);
}

function applySemanticAxisProfileSaveFailed(
  envelope: ProtocolEnvelope<SystemSemanticAxisProfileSaveFailedPayload>,
): void {
  state.latestSemanticAxisProfileSaveResult = {
    requestId: envelope.payload.request_id,
    ok: false,
    modelName: envelope.payload.model_name,
    profileId: envelope.payload.profile_id,
    expectedRevision: envelope.payload.expected_revision,
    errorCode: envelope.payload.error_code,
    message: envelope.payload.message,
    receivedAt: new Date().toISOString(),
  };
  state.lastError = envelope.payload.message;
  state.statusMessage = `主轴配置保存失败：${envelope.payload.message}`;
  pushHistory("error", state.statusMessage);
}

function applyMotionTuningSamplesState(
  envelope: ProtocolEnvelope<SystemMotionTuningSamplesStatePayload>,
): void {
  const samples = Array.isArray(envelope.payload.samples)
    ? envelope.payload.samples
      .map((sample) => normalizeMotionTuningSamplePayload(sample))
      .filter((sample): sample is DesktopMotionTuningSample => sample !== null)
    : [];
  const rootError = typeof envelope.payload.root_error === "string"
    ? envelope.payload.root_error.trim()
    : "";
  const loadError = typeof envelope.payload.load_error === "string"
    ? envelope.payload.load_error.trim()
    : "";
  const diagnostics = Array.isArray(envelope.payload.diagnostics)
    ? envelope.payload.diagnostics
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
    : [];
  state.motionTuningSamples = samples;
  state.motionTuningSamplesStatus = {
    rootError,
    loadError,
    diagnostics,
  };
  if (rootError) {
    state.lastError = rootError;
    state.statusMessage = `后端 runtime cache 根状态异常：${rootError}`;
    pushHistory("error", state.statusMessage);
    return;
  }
  if (loadError) {
    state.lastError = loadError;
    state.statusMessage = `后端动作调参样本池加载失败：${loadError}`;
    pushHistory("error", state.statusMessage);
    return;
  }
  state.lastError = "";
  state.statusMessage = samples.length
    ? `已同步 ${samples.length} 个后端动作调参样本。`
    : "后端当前没有已保存的动作调参样本。";
}

function applyHistoryList(
  envelope: ProtocolEnvelope<SystemHistoryListPayload>,
): void {
  state.backendHistorySummaries = normalizeBackendHistorySummaries(
    envelope.payload.histories,
  );
  state.backendHistoryLoading = false;
  state.lastError = "";

  const hasActiveHistory = state.backendHistorySummaries.some(
    (summary) => summary.uid === state.activeBackendHistoryUid,
  );
  if (!hasActiveHistory && state.activeBackendHistoryUid) {
    state.activeBackendHistoryUid = "";
    state.backendHistoryEntries = [];
  }

  state.backendHistoryStatusMessage = state.backendHistorySummaries.length
    ? `已同步 ${state.backendHistorySummaries.length} 条后端会话索引。`
    : "后端当前没有可用的对话历史。";
  state.statusMessage = state.backendHistoryStatusMessage;
  pushHistory("system", state.statusMessage);

  if (!state.activeBackendHistoryUid && state.backendHistorySummaries.length > 0) {
    void loadHistory(state.backendHistorySummaries[0].uid, { announce: false });
  }
}

function applyHistoryCreated(
  envelope: ProtocolEnvelope<SystemHistoryCreatedPayload>,
): void {
  const historyUid = envelope.payload.history_uid.trim();
  pendingHistoryLoadUid = null;
  state.backendHistoryLoading = false;
  state.activeBackendHistoryUid = historyUid;
  state.backendHistoryEntries = [];
  state.lastError = "";
  state.backendHistoryStatusMessage = historyUid
    ? `已创建新会话 ${historyUid}。`
    : "后端已创建新会话。";
  state.statusMessage = state.backendHistoryStatusMessage;
  pushHistory("system", state.statusMessage);

  if (historyUid) {
    const placeholderSummary: DesktopBackendHistorySummary = {
      uid: historyUid,
      latestMessage: null,
      timestamp: new Date().toISOString(),
    };
    state.backendHistorySummaries = [
      placeholderSummary,
      ...state.backendHistorySummaries.filter((summary) => summary.uid !== historyUid),
    ];
  }
}

function applyHistoryData(
  envelope: ProtocolEnvelope<SystemHistoryDataPayload>,
): void {
  state.backendHistoryEntries = normalizeBackendHistoryMessages(envelope.payload.messages);
  if (pendingHistoryLoadUid) {
    state.activeBackendHistoryUid = pendingHistoryLoadUid;
  }
  pendingHistoryLoadUid = null;
  state.backendHistoryLoading = false;
  state.lastError = "";
  state.backendHistoryStatusMessage = state.backendHistoryEntries.length
    ? `已载入 ${state.backendHistoryEntries.length} 条后端历史消息。`
    : "当前后端会话还没有历史消息。";
  state.statusMessage = state.backendHistoryStatusMessage;
  pushHistory("system", state.statusMessage);
}

function applyHistoryDeleted(
  envelope: ProtocolEnvelope<SystemHistoryDeletedPayload>,
): void {
  const historyUid = envelope.payload.history_uid.trim();
  state.backendHistoryLoading = false;

  if (!envelope.payload.success) {
    state.lastError = historyUid
      ? `删除会话 ${historyUid} 失败。`
      : "删除会话失败。";
    state.statusMessage = state.lastError;
    state.backendHistoryStatusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return;
  }

  state.backendHistorySummaries = state.backendHistorySummaries.filter(
    (summary) => summary.uid !== historyUid,
  );
  if (state.activeBackendHistoryUid === historyUid) {
    state.activeBackendHistoryUid = "";
    state.backendHistoryEntries = [];
  }
  state.lastError = "";
  state.backendHistoryStatusMessage = historyUid
    ? `已删除会话 ${historyUid}。`
    : "已删除当前会话。";
  state.statusMessage = state.backendHistoryStatusMessage;
  pushHistory("system", state.statusMessage);
  requestHistoryList({ announce: false });
}

function reportProtocolError(
  key: string,
  message: string,
  envelope?: ProtocolEnvelope<unknown>,
): void {
  state.lastError = message;
  state.statusMessage = message;
  if (!reportedProtocolWarnings.has(key)) {
    pushHistory("error", message);
    reportedProtocolWarnings.add(key);
  }
  console.warn("[Connection] protocol error.", message, envelope);
}

function reportUnhandledInboundEnvelope(
  envelope: ProtocolEnvelope<unknown>,
): void {
  const key = `type:${envelope.type}`;
  const message = `收到未接入的协议消息 ${envelope.type}。`;
  state.lastError = "";
  state.statusMessage = message;
  if (!reportedProtocolWarnings.has(key)) {
    pushHistory("system", message);
    reportedProtocolWarnings.add(key);
  }
  console.warn("[Connection] unhandled inbound protocol message.", envelope.type, envelope);
}

function applyInboundMotionPayload(
  envelope: ProtocolEnvelope<Record<string, unknown>>,
): void {
  console.info(
    "[Connection] engine motion payload received. type=",
    envelope.type,
    "turn_id=",
    envelope.turn_id,
    "currentTurnId=",
    state.currentTurnId,
  );

  if (
    envelope.turn_id
    && state.currentTurnId
    && envelope.turn_id !== state.currentTurnId
  ) {
    console.warn(
      "[Connection] discarding motion payload for stale turn_id. envelope_turn_id=",
      envelope.turn_id,
      "current_turn_id=",
      state.currentTurnId,
    );
    state.statusMessage = `忽略过期动作计划（turn_id=${envelope.turn_id}）。`;
    pushHistory("system", state.statusMessage);
    return;
  }

  const rawPayload = envelope.payload;
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const payloadKey = envelope.type === "engine.motion_intent" ? "intent" : "plan";
  const mode =
    typeof payload.mode === "string" && payload.mode.trim()
      ? payload.mode.trim()
      : "preview";
  const hasMotionPayload = Object.prototype.hasOwnProperty.call(payload, payloadKey);
  const plan = hasMotionPayload ? payload[payloadKey as keyof typeof payload] : null;

  console.info(
    "[Connection] engine motion payload parsed. type=",
    envelope.type,
    "payloadKey=",
    payloadKey,
    "hasMotionPayload=",
    hasMotionPayload,
    "plan type=",
    typeof plan,
    "plan keys=",
    plan && typeof plan === "object" ? Object.keys(plan as object) : "N/A",
  );

  if (!plan || typeof plan !== "object") {
    console.warn("[Connection] invalid motion payload envelope:", envelope);
    state.lastError = `收到无效的 ${envelope.type}（缺少 ${payloadKey} 对象）。`;
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return;
  }

  const schemaVersion =
    typeof (plan as Record<string, unknown>).schema_version === "string"
      ? String((plan as Record<string, unknown>).schema_version).trim()
      : "";
  const allowedSchemaVersions = envelope.type === "engine.motion_intent"
    ? new Set(["engine.motion_intent.v2"])
    : new Set(["engine.parameter_plan.v2"]);
  if (!allowedSchemaVersions.has(schemaVersion)) {
    console.warn(
      "[Connection] motion payload schema mismatch.",
      "type=",
      envelope.type,
      "expected=",
      [...allowedSchemaVersions].join("|"),
      "actual=",
      schemaVersion,
      envelope,
    );
    state.lastError = `收到无效的 ${envelope.type}（schema_version=${schemaVersion || "empty"}）。`;
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return;
  }

  state.inboundMotionPlan = plan;
  state.inboundMotionPlanTurnId = envelope.turn_id ?? null;
  state.inboundMotionPlanReceivedAtMs = performance.now();
  state.inboundMotionPlanNonce += 1;
  console.info("[Connection] inboundMotionPlanNonce incremented to", state.inboundMotionPlanNonce, "— watch should fire next.");
  state.statusMessage = `收到外部动作载荷（${envelope.type}, mode=${mode}）。`;
  pushHistory("system", state.statusMessage);
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
  state.audioPlaybackStartedTurnId = null;
  state.audioPlaybackStartedAtMs = 0;
  state.audioPlaybackDurationMs = null;
  state.statusMessage = "收到语音回复，正在播放。";
  pushHistory("system", state.statusMessage);

  // Feed audio to Live2D's wav handler for lip sync first so the mouth curve
  // is primed before HTMLAudioElement enters playback.
  const adapter = window.getLAppAdapter?.();
  if (adapter && typeof adapter.loadWavFileForLipSync === "function") {
    try {
      const lipSyncReady = await Promise.race<boolean | null>([
        adapter.loadWavFileForLipSync(audioUrl),
        new Promise<null>((resolve) => {
          window.setTimeout(() => resolve(null), 480);
        }),
      ]);
      if (lipSyncReady === false) {
        pushHistory("system", "嘴型同步加载失败，音频播放将无对应张嘴动作。");
      }
    } catch (_error) {
      pushHistory("system", "嘴型同步加载失败，音频播放将无对应张嘴动作。");
    }
  }

  const audio = new Audio(audioUrl);
  audioElement = audio;
  let resolvedDurationMs: number | null = null;
  let playbackStartNotified = false;

  const cleanup = () => {
    if (audioElement === audio) {
      audioElement = null;
    }
  };

  const syncDurationFromElement = () => {
    const durationSeconds = Number(audio.duration);
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      resolvedDurationMs = Math.round(durationSeconds * 1000);
      state.audioPlaybackDurationMs = resolvedDurationMs;
    }
  };

  const markPlaybackStarted = () => {
    if (playbackStartNotified || audioElement !== audio) {
      return;
    }
    playbackStartNotified = true;
    syncDurationFromElement();
    state.audioPlaybackStartedTurnId = turnId;
    state.audioPlaybackStartedAtMs = performance.now();
    state.audioPlaybackStartedNonce += 1;
    console.info(
      "[Connection] audio playback started. turn_id=",
      turnId,
      "duration_ms=",
      state.audioPlaybackDurationMs,
      "nonce=",
      state.audioPlaybackStartedNonce,
    );
  };

  audio.addEventListener(
    "loadedmetadata",
    () => {
      syncDurationFromElement();
    },
    { once: true },
  );

  audio.addEventListener(
    "playing",
    () => {
      markPlaybackStarted();
    },
    { once: true },
  );

  audio.addEventListener(
    "ended",
    () => {
      cleanup();
      state.isPlayingAudio = false;
      state.audioPlaybackStartedTurnId = null;
      state.audioPlaybackStartedAtMs = 0;
      state.audioPlaybackDurationMs = null;
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
      state.audioPlaybackStartedTurnId = null;
      state.audioPlaybackStartedAtMs = 0;
      state.audioPlaybackDurationMs = null;
      pushHistory("error", "音频播放失败。");
      void sendPlaybackFinished(turnId, false, "audio_playback_error");
    },
    { once: true },
  );

  try {
    await audio.play();
    markPlaybackStarted();
  } catch (error) {
    cleanup();
    state.isPlayingAudio = false;
    state.audioPlaybackStartedTurnId = null;
    state.audioPlaybackStartedAtMs = 0;
    state.audioPlaybackDurationMs = null;
    state.lastError =
      error instanceof Error ? error.message : "浏览器拒绝自动播放语音。";
    state.statusMessage = "语音播放失败，已回传结束状态。";
    pushHistory("error", state.statusMessage);
    await sendPlaybackFinished(turnId, false, "audio_autoplay_blocked");
  }
}

function stopAudioPlayback(): void {
  if (audioElement) {
    audioElement.pause();
    audioElement.currentTime = 0;
  }
  audioElement = null;
  state.audioPlaybackStartedTurnId = null;
  state.audioPlaybackStartedAtMs = 0;
  state.audioPlaybackDurationMs = null;
}

async function sendText(text: string): Promise<boolean> {
  const message = text.trim();
  if (!message || !socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，文本未发送。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  const desktopCapture = state.desktopScreenshotOnSendEnabled
    ? await captureRealtimeDesktopScreenshot()
    : null;
  const outboundText = buildDesktopAwareText(message, desktopCapture);
  const envelope = buildMessageEnvelope("input.text", {
    text: outboundText,
    images: desktopCapture ? [desktopCapture] : [],
  });
  socket.send(JSON.stringify(envelope));
  state.lastError = "";
  state.statusMessage = desktopCapture
    ? "文本和实时桌面截图已发送，等待后端回复。"
    : "文本已发送，等待后端回复。";
  pushHistory("user", message);
  return true;
}

async function captureRealtimeDesktopScreenshot(): Promise<DesktopCaptureImagePayload | null> {
  const captureDesktopScreenshot = window.ag99desktop?.captureDesktopScreenshot;
  if (!captureDesktopScreenshot) {
    return null;
  }

  try {
    return await captureDesktopScreenshot();
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

function sendSemanticAxisProfileSave(
  payload: SystemSemanticAxisProfileSavePayload,
): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，无法保存主轴配置。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  socket.send(
    JSON.stringify(
      buildMessageEnvelope("system.semantic_axis_profile_save", payload),
    ),
  );
  state.lastError = "";
  state.statusMessage = `已提交模型 ${payload.model_name} 的主轴配置保存请求。`;
  pushHistory("system", state.statusMessage);
  return true;
}

function requestHistoryList(
  options: { announce?: boolean } = {},
): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，无法读取对话历史。";
    state.statusMessage = state.lastError;
    state.backendHistoryStatusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  state.backendHistoryLoading = true;
  socket.send(
    JSON.stringify(
      buildMessageEnvelope("system.history_list_request", {}),
    ),
  );
  state.lastError = "";
  state.backendHistoryStatusMessage = "正在向后端请求对话历史列表。";
  state.statusMessage = state.backendHistoryStatusMessage;
  if (options.announce !== false) {
    pushHistory("system", state.statusMessage);
  }
  return true;
}

function createHistory(
  options: { announce?: boolean } = {},
): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，无法新建对话历史。";
    state.statusMessage = state.lastError;
    state.backendHistoryStatusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  state.backendHistoryLoading = true;
  pendingHistoryLoadUid = null;
  socket.send(
    JSON.stringify(
      buildMessageEnvelope("system.history_create", {}),
    ),
  );
  state.lastError = "";
  state.backendHistoryStatusMessage = "正在请求新建后端会话。";
  state.statusMessage = state.backendHistoryStatusMessage;
  if (options.announce !== false) {
    pushHistory("system", state.statusMessage);
  }
  return true;
}

function loadHistory(
  historyUid: string,
  options: { announce?: boolean } = {},
): boolean {
  const normalizedUid = historyUid.trim();
  if (!normalizedUid) {
    state.lastError = "历史会话 UID 为空，无法载入。";
    state.statusMessage = state.lastError;
    state.backendHistoryStatusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，无法载入对话历史。";
    state.statusMessage = state.lastError;
    state.backendHistoryStatusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  state.backendHistoryLoading = true;
  pendingHistoryLoadUid = normalizedUid;
  socket.send(
    JSON.stringify(
      buildMessageEnvelope("system.history_load", {
        history_uid: normalizedUid,
      }),
    ),
  );
  state.lastError = "";
  state.backendHistoryStatusMessage = `正在载入会话 ${normalizedUid}。`;
  state.statusMessage = state.backendHistoryStatusMessage;
  if (options.announce !== false) {
    pushHistory("system", state.statusMessage);
  }
  return true;
}

function deleteHistory(
  historyUid: string,
  options: { announce?: boolean } = {},
): boolean {
  const normalizedUid = historyUid.trim();
  if (!normalizedUid) {
    state.lastError = "历史会话 UID 为空，无法删除。";
    state.statusMessage = state.lastError;
    state.backendHistoryStatusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，无法删除对话历史。";
    state.statusMessage = state.lastError;
    state.backendHistoryStatusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  state.backendHistoryLoading = true;
  socket.send(
    JSON.stringify(
      buildMessageEnvelope("system.history_delete", {
        history_uid: normalizedUid,
      }),
    ),
  );
  state.lastError = "";
  state.backendHistoryStatusMessage = `正在删除会话 ${normalizedUid}。`;
  state.statusMessage = state.backendHistoryStatusMessage;
  if (options.announce !== false) {
    pushHistory("system", state.statusMessage);
  }
  return true;
}

function serializeMotionTuningSample(
  sample: DesktopMotionTuningSample,
): MotionTuningSampleProtocolPayload {
  return {
    id: sample.id,
    created_at: sample.createdAt,
    source_record_id: sample.sourceRecordId,
    model_name: sample.modelName,
    profile_id: sample.profileId ?? "",
    profile_revision: sample.profileRevision ?? 0,
    emotion_label: sample.emotionLabel,
    assistant_text: sample.assistantText,
    feedback: sample.feedback,
    tags: [...sample.tags],
    enabled_for_llm_reference: Boolean(sample.enabledForLlmReference),
    original_axes: { ...sample.originalAxes },
    adjusted_axes: { ...sample.adjustedAxes },
    adjusted_plan: JSON.parse(JSON.stringify(sample.adjustedPlan)) as DesktopMotionTuningSample["adjustedPlan"],
  };
}

function normalizeMotionTuningSamplePayload(
  sample: MotionTuningSampleProtocolPayload | unknown,
): DesktopMotionTuningSample | null {
  if (!sample || typeof sample !== "object") {
    return null;
  }

  const candidate = sample as Partial<MotionTuningSampleProtocolPayload>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const createdAt = typeof candidate.created_at === "string" ? candidate.created_at.trim() : "";
  const sourceRecordId = typeof candidate.source_record_id === "string"
    ? candidate.source_record_id.trim()
    : "";
  const modelName = typeof candidate.model_name === "string" ? candidate.model_name.trim() : "";
  const profileId = typeof candidate.profile_id === "string" ? candidate.profile_id.trim() : "";
  const profileRevision = typeof candidate.profile_revision === "number"
    && Number.isFinite(candidate.profile_revision)
    && candidate.profile_revision > 0
    ? Math.round(candidate.profile_revision)
    : 0;
  if (!id || !createdAt || !sourceRecordId || !modelName || !profileId || profileRevision <= 0) {
    return null;
  }

  const adjustedPlan = candidate.adjusted_plan;
  if (
    !adjustedPlan
    || typeof adjustedPlan !== "object"
    || adjustedPlan.schema_version !== "engine.parameter_plan.v2"
  ) {
    return null;
  }

  return {
    id,
    createdAt,
    sourceRecordId,
    modelName,
    profileId,
    profileRevision,
    emotionLabel: typeof candidate.emotion_label === "string" && candidate.emotion_label.trim()
      ? candidate.emotion_label.trim()
      : "manual_tuning",
    assistantText: typeof candidate.assistant_text === "string"
      ? candidate.assistant_text.trim()
      : "",
    feedback: typeof candidate.feedback === "string" ? candidate.feedback.trim() : "",
    tags: Array.isArray(candidate.tags)
      ? candidate.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : [],
    enabledForLlmReference: Boolean(candidate.enabled_for_llm_reference),
    originalAxes: normalizeMotionTuningAxisRecord(candidate.original_axes),
    adjustedAxes: normalizeMotionTuningAxisRecord(candidate.adjusted_axes),
    adjustedPlan: JSON.parse(JSON.stringify(adjustedPlan)) as DesktopMotionTuningSample["adjustedPlan"],
  };
}

function normalizeMotionTuningAxisRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof key !== "string" || !key.trim()) {
      continue;
    }
    if (typeof item !== "number" || !Number.isFinite(item)) {
      continue;
    }
    result[key.trim()] = item;
  }
  return result;
}

function saveMotionTuningSample(sample: DesktopMotionTuningSample): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，无法保存动作调参样本。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  socket.send(
    JSON.stringify(
      buildMessageEnvelope<SystemMotionTuningSampleSavePayload>(
        "system.motion_tuning_sample_save",
        {
          sample: serializeMotionTuningSample(sample),
        },
      ),
    ),
  );
  state.lastError = "";
  state.statusMessage = `已提交动作调参样本保存请求：${sample.id}`;
  pushHistory("system", state.statusMessage);
  return true;
}

function deleteMotionTuningSample(sampleId: string): boolean {
  const normalizedSampleId = sampleId.trim();
  if (!normalizedSampleId) {
    state.lastError = "动作调参样本 ID 为空，无法删除。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，无法删除动作调参样本。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  socket.send(
    JSON.stringify(
      buildMessageEnvelope<SystemMotionTuningSampleDeletePayload>(
        "system.motion_tuning_sample_delete",
        {
          sample_id: normalizedSampleId,
        },
      ),
    ),
  );
  state.lastError = "";
  state.statusMessage = `已提交动作调参样本删除请求：${normalizedSampleId}`;
  pushHistory("system", state.statusMessage);
  return true;
}

function sendMotionPayloadPreview(payload: unknown): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    state.lastError = "当前还没有连上适配器，无法发送动作测试载荷。";
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    return false;
  }

  const schemaVersion = payload && typeof payload === "object"
    ? String((payload as Record<string, unknown>).schema_version ?? "").trim()
    : "";
  if (
    schemaVersion !== "engine.motion_intent.v2"
    && schemaVersion !== "engine.parameter_plan.v2"
  ) {
    state.lastError = `动作测试载荷无效：不支持 schema_version=${schemaVersion || "empty"}。`;
    state.statusMessage = state.lastError;
    pushHistory("error", state.lastError);
    console.warn("[Connection] refusing invalid motion preview payload:", payload);
    return false;
  }

  const messageType = schemaVersion === "engine.motion_intent.v2"
    ? "engine.motion_intent"
    : "engine.motion_plan";
  const payloadKey = messageType === "engine.motion_intent" ? "intent" : "plan";

  socket.send(
    JSON.stringify(
      buildMessageEnvelope(messageType, {
        mode: "preview",
        [payloadKey]: payload,
      }),
    ),
  );
  state.statusMessage = `已发送动作测试载荷（${messageType}）。`;
  pushHistory("system", state.statusMessage);
  return true;
}

function sendMotionPlanPreview(plan: unknown): boolean {
  return sendMotionPayloadPreview(plan);
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
  const runtimeCacheErrors = normalizeRuntimeCacheErrors(
    envelope.payload.runtime_cache_errors ?? modelInfo.runtime_cache_errors,
  );
  const modelInfoWithRuntimeCacheErrors: ModelSyncInfo = {
    ...modelInfo,
    runtime_cache_errors: runtimeCacheErrors,
  };
  return {
    ...envelope,
    payload: {
      ...envelope.payload,
      model_info: modelInfoWithRuntimeCacheErrors,
      runtime_cache_errors: runtimeCacheErrors,
    },
  };
}

function rewriteModelInfo(modelInfo: ModelSyncInfo): ModelSyncInfo {
  return {
    ...modelInfo,
    runtime_cache_errors: normalizeRuntimeCacheErrors(modelInfo.runtime_cache_errors),
    models: modelInfo.models.map((model) => ({
      ...model,
      model_url: rewriteHttpUrl(model.model_url),
      icon_url: rewriteHttpUrl(model.icon_url),
    })),
  };
}

function normalizeRuntimeCacheErrors(
  value: RuntimeCacheErrorsPayload | undefined,
): RuntimeCacheErrorsPayload | undefined {
  if (!value) {
    return undefined;
  }
  const normalized: RuntimeCacheErrorsPayload = {};
  const root = typeof value.root === "string" ? value.root.trim() : "";
  const scanCache = typeof value.scan_cache === "string" ? value.scan_cache.trim() : "";
  const actionFilterCache = typeof value.action_filter_cache === "string"
    ? value.action_filter_cache.trim()
    : "";
  const motionTuningSamples = typeof value.motion_tuning_samples === "string"
    ? value.motion_tuning_samples.trim()
    : "";
  if (root) {
    normalized.root = root;
  }
  if (scanCache) {
    normalized.scan_cache = scanCache;
  }
  if (actionFilterCache) {
    normalized.action_filter_cache = actionFilterCache;
  }
  if (motionTuningSamples) {
    normalized.motion_tuning_samples = motionTuningSamples;
  }
  return Object.keys(normalized).length ? normalized : undefined;
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

function normalizeBackendHistorySummaries(
  histories: unknown,
): DesktopBackendHistorySummary[] {
  if (!Array.isArray(histories)) {
    return [];
  }

  const normalized: DesktopBackendHistorySummary[] = [];
  for (const history of histories) {
    if (!history || typeof history !== "object") {
      continue;
    }

    const candidate = history as Record<string, unknown>;
    const uid = typeof candidate.uid === "string" ? candidate.uid.trim() : "";
    if (!uid) {
      continue;
    }

    const latestMessage = normalizeBackendHistorySummaryMessage(candidate.latest_message);
    const timestamp = typeof candidate.timestamp === "string"
      ? candidate.timestamp.trim()
      : latestMessage?.timestamp ?? "";

    normalized.push({
      uid,
      latestMessage,
      timestamp,
    });
  }

  return normalized;
}

function normalizeBackendHistorySummaryMessage(
  message: unknown,
): DesktopBackendHistorySummary["latestMessage"] {
  if (!message || typeof message !== "object") {
    return null;
  }

  const candidate = message as Record<string, unknown>;
  const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
  const timestamp = typeof candidate.timestamp === "string" ? candidate.timestamp.trim() : "";
  const role = normalizeBackendHistoryRole(candidate.role);
  if (!content && !timestamp) {
    return null;
  }

  return {
    role,
    timestamp,
    content,
  };
}

function normalizeBackendHistoryMessages(
  messages: unknown,
): DesktopBackendHistoryMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  const normalized: DesktopBackendHistoryMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const candidate = message as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id) {
      continue;
    }

    normalized.push({
      id,
      role: normalizeBackendHistoryRole(candidate.role),
      type: typeof candidate.type === "string" && candidate.type.trim()
        ? candidate.type.trim()
        : "text",
      content: typeof candidate.content === "string" ? candidate.content.trim() : "",
      timestamp: typeof candidate.timestamp === "string" ? candidate.timestamp.trim() : "",
      name: typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim()
        : undefined,
      toolId: typeof candidate.tool_id === "string" && candidate.tool_id.trim()
        ? candidate.tool_id.trim()
        : undefined,
      toolName: typeof candidate.tool_name === "string" && candidate.tool_name.trim()
        ? candidate.tool_name.trim()
        : undefined,
      status: typeof candidate.status === "string" && candidate.status.trim()
        ? candidate.status.trim()
        : undefined,
      avatar: typeof candidate.avatar === "string" && candidate.avatar.trim()
        ? candidate.avatar.trim()
        : undefined,
    });
  }

  return normalized;
}

function normalizeBackendHistoryRole(
  role: unknown,
): DesktopBackendHistoryMessage["role"] {
  if (typeof role !== "string") {
    return "system";
  }
  const normalizedRole = role.trim().toLowerCase();
  if (normalizedRole === "human" || normalizedRole === "ai") {
    return normalizedRole;
  }
  return "system";
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
    setDesktopScreenshotOnSendEnabled,
    connect,
    disconnect,
    sendText,
    interruptCurrentTurn,
    sendSemanticAxisProfileSave,
    requestHistoryList,
    createHistory,
    loadHistory,
    deleteHistory,
    saveMotionTuningSample,
    deleteMotionTuningSample,
    sendMotionPayloadPreview,
    sendMotionPlanPreview,
    toggleMicrophoneCapture,
    pushHistory,
  };
}
