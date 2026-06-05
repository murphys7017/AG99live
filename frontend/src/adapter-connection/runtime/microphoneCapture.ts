import type { DesktopMicrophoneAudioChunk } from "../../types/desktop.js";
import { cloneArrayBuffer, float32ToPcm16le } from "./audioStreamFrame.js";

export type MicrophoneAudioChunk = DesktopMicrophoneAudioChunk;

export interface StartMicrophoneCaptureOptions {
  deviceId: string | null;
  onChunk: (chunk: MicrophoneAudioChunk) => void;
  onDeviceEnded: () => void;
}

interface MicrophoneCaptureRuntime {
  sampleRate: number;
  kind: "web";
  mediaStream: MediaStream;
  audioContext: AudioContext;
  sourceNode: MediaStreamAudioSourceNode;
  processorNode: AudioWorkletNode;
  sinkGainNode: GainNode;
}

interface NativeMicrophoneCaptureRuntime {
  sampleRate: number;
  kind: "native";
  sessionId: string;
  detachChunkListener: () => void;
  detachEndedListener: () => void;
  detachErrorListener: () => void;
}

const MIC_TARGET_SAMPLE_RATE = 16000;
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

let microphoneRuntime: MicrophoneCaptureRuntime | NativeMicrophoneCaptureRuntime | null = null;

export function isMicrophoneCaptureRuntimeActive(): boolean {
  return Boolean(microphoneRuntime);
}

export async function startMicrophoneCaptureRuntime(
  options: StartMicrophoneCaptureOptions,
): Promise<void> {
  if (microphoneRuntime) {
    return;
  }

  let mediaStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let processorNode: AudioWorkletNode | null = null;
  let sinkGainNode: GainNode | null = null;

  try {
    const selectedDeviceId = normalizeMicrophoneDeviceId(options.deviceId);
    const selectedNativeDevice = isNativeMicrophoneDeviceId(selectedDeviceId);
    if (selectedDeviceId) {
      const nativeStarted = await tryStartNativeMicrophoneCaptureRuntime(
        selectedDeviceId,
        options,
      );
      if (nativeStarted) {
        return;
      }
      if (selectedNativeDevice) {
        throw new Error("原生麦克风采集启动失败，请确认 ffmpeg 可用且设备未被独占。");
      }
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前环境不支持麦克风采集。");
    }

    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) {
      throw new Error("当前环境不支持 Web Audio API。");
    }

    const audioConstraints: MediaTrackConstraints = {
      channelCount: 1,
      sampleRate: MIC_TARGET_SAMPLE_RATE,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (selectedDeviceId) {
      audioConstraints.deviceId = { exact: selectedDeviceId };
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
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
        options.onChunk(buildMicrophoneAudioChunk(inputChunk, runtime.sampleRate));
      },
    );

    microphoneRuntime = {
      kind: "web",
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
          options.onDeviceEnded();
        },
        { once: true },
      );
    }
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
    throw error;
  }
}

function normalizeMicrophoneDeviceId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isNativeMicrophoneDeviceId(value: string): boolean {
  return value.startsWith("@device_") || value.startsWith("native:");
}

export async function stopMicrophoneCaptureRuntime(): Promise<boolean> {
  const runtime = microphoneRuntime;
  if (!runtime) {
    return false;
  }

  microphoneRuntime = null;
  if (runtime.kind === "native") {
    runtime.detachChunkListener();
    runtime.detachEndedListener();
    runtime.detachErrorListener();
    await window.ag99desktop?.stopNativeMicrophoneCapture?.(runtime.sessionId);
    return true;
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

  return true;
}

async function tryStartNativeMicrophoneCaptureRuntime(
  deviceId: string,
  options: StartMicrophoneCaptureOptions,
): Promise<boolean> {
  if (!window.ag99desktop?.startNativeMicrophoneCapture) {
    return false;
  }

  const startResult = await window.ag99desktop.startNativeMicrophoneCapture(deviceId);
  if (!startResult.ok) {
    console.warn("[Connection] native microphone capture unavailable.", startResult.error);
    return false;
  }

  const sessionId = startResult.sessionId;
  const detachChunkListener = window.ag99desktop.onNativeMicrophoneChunk?.((
    chunk: DesktopMicrophoneAudioChunk & { sessionId: string },
  ) => {
    if (chunk.sessionId !== sessionId || microphoneRuntime?.kind !== "native") {
      return;
    }
    options.onChunk({
      audio: chunk.audio,
      pcm16le: chunk.pcm16le ? cloneArrayBuffer(chunk.pcm16le) : undefined,
      sampleRate: chunk.sampleRate,
      channels: chunk.channels,
    });
  }) ?? (() => {});
  const detachEndedListener = window.ag99desktop.onNativeMicrophoneEnded?.((
    payload: { sessionId: string; reason: string },
  ) => {
    if (payload.sessionId === sessionId) {
      options.onDeviceEnded();
    }
  }) ?? (() => {});
  const detachErrorListener = window.ag99desktop.onNativeMicrophoneError?.((
    payload: { sessionId: string; error: string },
  ) => {
    if (payload.sessionId === sessionId) {
      console.warn("[Connection] native microphone capture failed.", payload.error);
      options.onDeviceEnded();
    }
  }) ?? (() => {});

  microphoneRuntime = {
    kind: "native",
    sampleRate: MIC_TARGET_SAMPLE_RATE,
    sessionId,
    detachChunkListener,
    detachEndedListener,
    detachErrorListener,
  };
  return true;
}

function buildMicrophoneAudioChunk(
  inputChunk: Float32Array,
  sourceSampleRate: number,
): MicrophoneAudioChunk {
  const normalizedChunk = downsampleAudioBuffer(
    inputChunk,
    sourceSampleRate,
    MIC_TARGET_SAMPLE_RATE,
  );
  return {
    pcm16le: float32ToPcm16le(normalizedChunk),
    sampleRate: MIC_TARGET_SAMPLE_RATE,
    channels: 1,
  };
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

async function createMicrophoneProcessorNode(
  audioContext: AudioContext,
  onChunk: (inputChunk: Float32Array) => void,
): Promise<AudioWorkletNode> {
  if (!audioContext.audioWorklet || typeof AudioWorkletNode === "undefined") {
    throw new Error("当前环境不支持 AudioWorklet，麦克风采集已停止。");
  }

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
  } finally {
    if (moduleUrl) {
      URL.revokeObjectURL(moduleUrl);
    }
  }
}

function disconnectMicrophoneProcessorNode(
  processorNode: AudioWorkletNode | null,
): void {
  if (!processorNode) {
    return;
  }

  processorNode.port.onmessage = null;
  processorNode.port.onmessageerror = null;
  processorNode.port.close();
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
