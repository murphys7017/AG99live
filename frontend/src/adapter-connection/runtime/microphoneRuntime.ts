import type { DesktopHistoryEntry } from "../../types/desktop";
import type { ProtocolEnvelope } from "../../types/protocol";
import {
  isMicrophoneCaptureRuntimeActive,
  startMicrophoneCaptureRuntime,
  stopMicrophoneCaptureRuntime,
  type MicrophoneAudioChunk,
} from "./microphoneCapture.js";
import {
  listMicrophoneInputDevices,
  type MicrophoneDeviceInfo,
} from "./microphoneDevices.js";
import {
  normalizeMicrophoneDeviceId,
  saveStoredPttKeyBinding,
  saveStoredMicrophoneDeviceId,
} from "../core/preferences.js";
import {
  normalizePttKeyBinding,
} from "../core/pttKeyBinding.js";
import type { DesktopPttKeyBinding } from "../../types/desktop.js";
import { buildAudioStreamChunkFrame, float32ToPcm16le } from "./audioStreamFrame.js";

export type MicrophoneCaptureOrigin = "manual" | "ptt" | "auto";

export interface AdapterMicrophoneRuntimeState {
  microphoneDeviceId: string;
  microphoneDevices: MicrophoneDeviceInfo[];
  micRequested: boolean;
  micCapturing: boolean;
  pttModeEnabled: boolean;
  pttKeyBinding: DesktopPttKeyBinding;
  lastError: string;
  statusMessage: string;
}

export interface AdapterMicrophoneRuntimeDeps {
  state: AdapterMicrophoneRuntimeState;
  getSocket: () => WebSocket | null;
  buildEnvelope: <TPayload>(
    type: string,
    payload: TPayload,
    turnId?: string | null,
  ) => ProtocolEnvelope<TPayload>;
  pushHistory: (role: Extract<DesktopHistoryEntry["role"], "system" | "error">, text: string) => void;
  createMessageId: () => string;
  setDesktopPttMode?: (enabled: boolean, binding: DesktopPttKeyBinding) => void;
}

export interface RefreshMicrophoneDevicesOptions {
  requestPermission?: boolean;
}

export interface AdapterMicrophoneRuntime {
  setMicrophoneDevice: (deviceId: string) => void;
  setMicrophoneDevices: (devices: readonly MicrophoneDeviceInfo[]) => void;
  refreshMicrophoneDevices: (options?: RefreshMicrophoneDevicesOptions) => Promise<void>;
  toggleMicrophoneCapture: () => Promise<boolean>;
  startMicrophoneCapture: (origin?: MicrophoneCaptureOrigin) => Promise<boolean>;
  stopMicrophoneCapture: (reason?: string) => Promise<boolean>;
  setPttMode: (enabled: boolean) => void;
  setPttKeyBinding: (binding: DesktopPttKeyBinding) => void;
  startPttCapture: () => Promise<void>;
  stopPttCapture: () => Promise<void>;
  clearPendingStart: () => void;
}

const MAX_MIC_SOCKET_BUFFERED_AMOUNT = 512 * 1024;
const ROOT_INPUT_TURN_PREFIX = "input:";

export function createAdapterMicrophoneRuntime(
  deps: AdapterMicrophoneRuntimeDeps,
): AdapterMicrophoneRuntime {
  let micStartPromise: Promise<boolean> | null = null;
  let audioSequenceBroken = false;
  let activeMicTurnId: string | null = null;
  let activeMicStreamId: string | null = null;
  let activeMicSeq = 0;
  let audioStreamStarted = false;
  let micCaptureOrigin: MicrophoneCaptureOrigin | null = null;

  function sendMicrophoneAudioChunk(chunk: MicrophoneAudioChunk): void {
    const socket = deps.getSocket();
    if (
      !socket
      || socket.readyState !== WebSocket.OPEN
    ) {
      if (isMicrophoneCaptureRuntimeActive()) {
        audioSequenceBroken = true;
      }
      return;
    }

    if (socket.bufferedAmount > MAX_MIC_SOCKET_BUFFERED_AMOUNT) {
      if (!audioSequenceBroken) {
        audioSequenceBroken = true;
        deps.state.lastError = "麦克风音频发送积压，本段收音已丢弃。";
        deps.state.statusMessage = deps.state.lastError;
        deps.pushHistory("error", deps.state.lastError);
      }
      return;
    }

    const audioPayload = resolveAudioPayload(chunk);
    if (!audioPayload.byteLength) {
      return;
    }

    const turnId = getOrCreateActiveMicTurnId();
    const streamId = getOrCreateActiveMicStreamId();
    if (!audioStreamStarted) {
      socket.send(
        JSON.stringify(
          deps.buildEnvelope(
            "input.audio_stream_start",
            {
              stream_id: streamId,
              source: resolveMicrophoneStreamSource(),
              device_id: deps.state.microphoneDeviceId || "",
              encoding: "pcm16le",
              sample_rate: chunk.sampleRate,
              channels: chunk.channels,
            },
            turnId,
          ),
        ),
      );
      audioStreamStarted = true;
    }

    socket.send(
      buildAudioStreamChunkFrame(
        {
          stream_id: streamId,
          turn_id: turnId,
          seq: activeMicSeq,
          encoding: "pcm16le",
          sample_rate: chunk.sampleRate,
          channels: chunk.channels,
        },
        audioPayload,
      ),
    );
    activeMicSeq += 1;
  }

  function setMicrophoneDevice(deviceId: string): void {
    const normalized = normalizeMicrophoneDeviceId(deviceId);
    if (normalized === deps.state.microphoneDeviceId) {
      return;
    }

    const shouldRestartCapture = deps.state.micCapturing || isMicrophoneCaptureRuntimeActive();
    deps.state.microphoneDeviceId = normalized;
    saveStoredMicrophoneDeviceId(normalized);
    if (shouldRestartCapture) {
      void restartMicrophoneCaptureAfterDeviceChange();
    }
  }

  function setMicrophoneDevices(devices: readonly MicrophoneDeviceInfo[]): void {
    const normalizedDevices = devices
      .map((device, index) => ({
        deviceId: normalizeMicrophoneDeviceId(device.deviceId),
        label: typeof device.label === "string" && device.label.trim()
          ? device.label.trim()
          : `麦克风 ${index + 1}`,
      }))
      .filter((device) => device.deviceId);

    deps.state.microphoneDevices = normalizedDevices;
    if (
      normalizedDevices.length > 0
      && deps.state.microphoneDeviceId
      && !normalizedDevices.some((device) => device.deviceId === deps.state.microphoneDeviceId)
    ) {
      setMicrophoneDevice("");
    }
  }

  async function refreshMicrophoneDevices(
    options: RefreshMicrophoneDevicesOptions = {},
  ): Promise<void> {
    try {
      const devices = await listMicrophoneInputDevices({
        requestPermission: options.requestPermission ?? true,
      });
      setMicrophoneDevices(devices);
    } catch (error) {
      console.warn("[Connection] failed to enumerate microphone devices.", error);
    }
  }

  async function toggleMicrophoneCapture(): Promise<boolean> {
    if (deps.state.micCapturing) {
      return stopMicrophoneCapture("manual_stop");
    }

    return startMicrophoneCapture("manual");
  }

  async function startMicrophoneCapture(
    origin: MicrophoneCaptureOrigin = "manual",
  ): Promise<boolean> {
    if (micStartPromise) {
      return micStartPromise;
    }
    if (deps.state.micCapturing) {
      return true;
    }

    const socket = deps.getSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      deps.state.lastError = "当前还没有连上适配器，无法启动麦克风。";
      deps.state.statusMessage = deps.state.lastError;
      deps.pushHistory("error", deps.state.lastError);
      return false;
    }

    deps.state.statusMessage = "正在请求麦克风权限...";

    micStartPromise = (async () => {
      try {
        audioSequenceBroken = false;
        activeMicTurnId = createRootInputTurnId();
        micCaptureOrigin = origin;
        await startMicrophoneCaptureRuntime({
          deviceId: deps.state.microphoneDeviceId || null,
          onChunk: (chunk) => {
            sendMicrophoneAudioChunk(chunk);
          },
          onDeviceEnded: () => {
            void stopMicrophoneCapture("device_ended");
          },
        });

        deps.state.micCapturing = true;
        deps.state.micRequested = true;
        deps.state.lastError = "";
        deps.state.statusMessage = "麦克风已开启，正在自动检测说话。";
        void refreshMicrophoneDevices({ requestPermission: false });
        deps.pushHistory("system", deps.state.statusMessage);
        return true;
      } catch (error) {
        deps.state.micCapturing = false;
        activeMicTurnId = null;
        activeMicStreamId = null;
        activeMicSeq = 0;
        audioStreamStarted = false;
        micCaptureOrigin = null;
        deps.state.lastError =
          error instanceof Error ? error.message : "麦克风启动失败。";
        deps.state.statusMessage = `麦克风启动失败：${deps.state.lastError}`;
        deps.pushHistory("error", deps.state.statusMessage);
        return false;
      } finally {
        micStartPromise = null;
      }
    })();

    return micStartPromise;
  }

  async function restartMicrophoneCaptureAfterDeviceChange(): Promise<void> {
    const previousOrigin = micCaptureOrigin ?? "manual";
    await stopMicrophoneCapture("device_change");
    const started = await startMicrophoneCapture(previousOrigin);
    if (!started) {
      deps.state.micRequested = false;
    }
  }

  function setPttMode(enabled: boolean): void {
    deps.state.pttModeEnabled = enabled;
    deps.setDesktopPttMode?.(enabled, deps.state.pttKeyBinding);
    if (enabled) {
      if (deps.state.micCapturing || isMicrophoneCaptureRuntimeActive()) {
        void stopMicrophoneCapture("ptt_mode_enabled");
      }
    }
  }

  function setPttKeyBinding(binding: DesktopPttKeyBinding): void {
    const normalized = normalizePttKeyBinding(binding);
    deps.state.pttKeyBinding = normalized;
    saveStoredPttKeyBinding(normalized);
    if (deps.state.pttModeEnabled) {
      deps.setDesktopPttMode?.(true, normalized);
    }
  }

  async function startPttCapture(): Promise<void> {
    if (!deps.state.pttModeEnabled) {
      return;
    }
    if (deps.state.micCapturing) {
      return;
    }
    await startMicrophoneCapture("ptt");
  }

  async function stopPttCapture(): Promise<void> {
    if (!deps.state.pttModeEnabled) {
      return;
    }
    if (!deps.state.micCapturing) {
      return;
    }
    if (micCaptureOrigin !== "ptt") {
      return;
    }
    await stopMicrophoneCapture("ptt_release");
  }

  async function stopMicrophoneCapture(reason = "manual_stop"): Promise<boolean> {
    if (!isMicrophoneCaptureRuntimeActive()) {
      deps.state.micCapturing = false;
      if (reason === "manual_stop") {
        deps.state.micRequested = false;
      }
      clearMicCaptureSession();
      return false;
    }

    deps.state.micCapturing = false;
    if (reason === "manual_stop" || reason === "device_ended" || reason === "ptt_release") {
      deps.state.micRequested = false;
    }

    await stopMicrophoneCaptureRuntime();

    const inputTurnId = activeMicTurnId ?? createRootInputTurnId();
    const inputStreamId = activeMicStreamId;
    const socket = deps.getSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
      const endType = audioStreamStarted && inputStreamId
        ? "input.audio_stream_end"
        : "input.mic_audio_end";
      const payload = audioStreamStarted && inputStreamId
        ? {
            stream_id: inputStreamId,
            reason,
            dropped: audioSequenceBroken,
            last_seq: activeMicSeq - 1,
          }
        : {
            reason,
            dropped: audioSequenceBroken,
          };
      socket.send(JSON.stringify(deps.buildEnvelope(endType, payload, inputTurnId)));
    }
    clearMicCaptureSession();

    if (reason === "device_change") {
      return true;
    }

    deps.state.statusMessage =
      reason === "manual_stop"
        ? "麦克风已关闭。"
        : "麦克风采集已停止。";
    if (reason !== "connection_closed" && reason !== "connection_reset") {
      deps.pushHistory("system", deps.state.statusMessage);
    }
    return true;
  }

  function clearPendingStart(): void {
    micStartPromise = null;
  }

  function createRootInputTurnId(): string {
    return `${ROOT_INPUT_TURN_PREFIX}${deps.createMessageId()}`;
  }

  function getOrCreateActiveMicTurnId(): string {
    if (!activeMicTurnId) {
      activeMicTurnId = createRootInputTurnId();
    }
    return activeMicTurnId;
  }

  function getOrCreateActiveMicStreamId(): string {
    if (!activeMicStreamId) {
      activeMicStreamId = `mic:${deps.createMessageId()}`;
    }
    return activeMicStreamId;
  }

  function resolveMicrophoneStreamSource(): string {
    return deps.state.microphoneDeviceId.startsWith("@device_")
      || deps.state.microphoneDeviceId.startsWith("native:")
      ? "native_dshow"
      : "web_audio";
  }

  function resolveAudioPayload(chunk: MicrophoneAudioChunk): ArrayBuffer {
    if (chunk.pcm16le instanceof ArrayBuffer) {
      return chunk.pcm16le;
    }
    if (chunk.audio?.length) {
      return float32ToPcm16le(Float32Array.from(chunk.audio));
    }
    return new ArrayBuffer(0);
  }

  function clearMicCaptureSession(): void {
    activeMicTurnId = null;
    activeMicStreamId = null;
    activeMicSeq = 0;
    audioStreamStarted = false;
    micCaptureOrigin = null;
    audioSequenceBroken = false;
  }

  return {
    setMicrophoneDevice,
    setMicrophoneDevices,
    refreshMicrophoneDevices,
    toggleMicrophoneCapture,
    startMicrophoneCapture,
    stopMicrophoneCapture,
    setPttMode,
    setPttKeyBinding,
    startPttCapture,
    stopPttCapture,
    clearPendingStart,
  };
}
