export interface MicrophoneAudioChunk {
  audio: number[];
  sampleRate: number;
  channels: 1;
}

export interface StartMicrophoneCaptureOptions {
  onChunk: (chunk: MicrophoneAudioChunk) => void;
  onDeviceEnded: () => void;
}

interface MicrophoneCaptureRuntime {
  sampleRate: number;
  mediaStream: MediaStream;
  audioContext: AudioContext;
  sourceNode: MediaStreamAudioSourceNode;
  processorNode: AudioWorkletNode;
  sinkGainNode: GainNode;
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

let microphoneRuntime: MicrophoneCaptureRuntime | null = null;

export function isMicrophoneCaptureRuntimeActive(): boolean {
  return Boolean(microphoneRuntime);
}

export async function startMicrophoneCaptureRuntime(
  options: StartMicrophoneCaptureOptions,
): Promise<void> {
  if (microphoneRuntime) {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前环境不支持麦克风采集。");
  }

  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) {
    throw new Error("当前环境不支持 Web Audio API。");
  }

  let mediaStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let processorNode: AudioWorkletNode | null = null;
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
        options.onChunk(buildMicrophoneAudioChunk(inputChunk, runtime.sampleRate));
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

export async function stopMicrophoneCaptureRuntime(): Promise<boolean> {
  const runtime = microphoneRuntime;
  if (!runtime) {
    return false;
  }

  microphoneRuntime = null;
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
    audio: serializeAudioChunk(normalizedChunk),
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

function serializeAudioChunk(audioBuffer: Float32Array): number[] {
  const serialized = new Array<number>(audioBuffer.length);
  for (let index = 0; index < audioBuffer.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, audioBuffer[index] ?? 0));
    serialized[index] = Math.round(sample * 10000) / 10000;
  }
  return serialized;
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
