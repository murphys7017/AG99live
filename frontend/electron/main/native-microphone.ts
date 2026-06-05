import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { DesktopMicrophoneDevice } from "../../src/types/desktop";

const FFMPEG_SAMPLE_RATE = 16000;
const FFMPEG_CHANNELS = 1;
const FFMPEG_CHUNK_SAMPLES = 1024;
const FFMPEG_CHUNK_BYTES = FFMPEG_CHUNK_SAMPLES * Int16Array.BYTES_PER_ELEMENT;
const FFMPEG_STARTUP_READY_TIMEOUT_MS = 4000;
const FFMPEG_STARTUP_FLUSH_DELAY_MS = 25;

interface NativeMicrophoneDevice extends DesktopMicrophoneDevice {
  alternativeName: string;
}

interface NativeCaptureRuntime {
  sessionId: string;
  ownerId: number;
  process: ChildProcessByStdio<null, Readable, Readable>;
  pendingBytes: Buffer;
  stopping: boolean;
  ready: boolean;
  forwardingEnabled: boolean;
  stderrLines: string[];
  startup: NativeCaptureStartup | null;
}

interface NativeCaptureStartup {
  settled: boolean;
  timeout: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: string) => void;
}

let deviceCache: {
  devices: NativeMicrophoneDevice[];
  capturedAtMs: number;
} | null = null;
let activeCapture: NativeCaptureRuntime | null = null;

const captureEvents = new EventEmitter();

export function setupNativeMicrophoneIpc(): void {
  ipcMain.handle("desktop:list-native-microphones", async () => {
    return listNativeMicrophones();
  });

  ipcMain.handle(
    "desktop:start-native-microphone-capture",
    async (event, deviceId: string | null) => {
      return startNativeMicrophoneCapture(event, deviceId);
    },
  );

  ipcMain.handle(
    "desktop:stop-native-microphone-capture",
    async (event, sessionId: string) => {
      return stopNativeMicrophoneCapture(event, sessionId);
    },
  );
}

async function listNativeMicrophones(): Promise<NativeMicrophoneDevice[]> {
  if (process.platform !== "win32") {
    return [];
  }

  const now = Date.now();
  if (deviceCache && now - deviceCache.capturedAtMs < 5000) {
    return cloneDevices(deviceCache.devices);
  }

  let output: string;
  try {
    output = await runFfmpegForOutput([
      "-hide_banner",
      "-list_devices",
      "true",
      "-f",
      "dshow",
      "-i",
      "dummy",
    ]);
  } catch (error) {
    console.warn("[NativeMicrophone] failed to enumerate DirectShow audio devices.", error);
    return [];
  }

  const devices = parseDirectShowAudioDevices(output);
  deviceCache = {
    devices,
    capturedAtMs: now,
  };
  return cloneDevices(devices);
}

async function startNativeMicrophoneCapture(
  event: IpcMainInvokeEvent,
  deviceId: string | null,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  if (process.platform !== "win32") {
    return { ok: false, error: "native_microphone_unsupported_platform" };
  }

  await stopActiveCapture("restart");

  const devices = await listNativeMicrophones();
  const selectedDevice = selectNativeMicrophoneDevice(devices, deviceId);
  if (!selectedDevice) {
    return { ok: false, error: "native_microphone_device_not_found" };
  }

  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) {
    return { ok: false, error: "ffmpeg_not_found" };
  }

  const sessionId = randomUUID();
  const child = spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "dshow",
      "-i",
      `audio=${selectedDevice.alternativeName || selectedDevice.label}`,
      "-ac",
      String(FFMPEG_CHANNELS),
      "-ar",
      String(FFMPEG_SAMPLE_RATE),
      "-f",
      "s16le",
      "pipe:1",
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const runtime: NativeCaptureRuntime = {
    sessionId,
    ownerId: event.sender.id,
    process: child,
    pendingBytes: Buffer.alloc(0),
    stopping: false,
    ready: false,
    forwardingEnabled: false,
    stderrLines: [],
    startup: null,
  };
  const startup = createNativeCaptureStartup(runtime);
  runtime.startup = startup;
  activeCapture = runtime;

  child.stdout.on("data", (chunk: Buffer) => {
    handleNativeCaptureBytes(runtime, event.sender, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      runtime.stderrLines.push(text);
      if (runtime.stderrLines.length > 8) {
        runtime.stderrLines.splice(0, runtime.stderrLines.length - 8);
      }
      console.warn("[NativeMicrophone] ffmpeg:", text);
    }
  });
  child.on("error", (error) => {
    failNativeCaptureStartup(runtime, error.message);
    if (runtime.ready) {
      emitNativeCaptureError(runtime, event.sender, error.message);
    }
  });
  child.on("exit", (code, signal) => {
    const reason = runtime.stopping ? "stopped" : `ffmpeg_exit:${code ?? "null"}:${signal ?? "null"}`;
    if (activeCapture === runtime) {
      activeCapture = null;
    }
    failNativeCaptureStartup(runtime, appendNativeCaptureStderr(runtime, reason));
    if (runtime.ready) {
      event.sender.send("desktop:native-microphone-ended", {
        sessionId,
        reason,
      });
    }
    captureEvents.emit(`ended:${sessionId}`);
  });

  try {
    await startup.promise;
  } catch (error) {
    await stopActiveCapture("startup_failed");
    return {
      ok: false,
      error: error instanceof Error ? error.message : "native_microphone_start_failed",
    };
  }

  runtime.ready = true;
  runtime.startup = null;
  runtime.pendingBytes = Buffer.alloc(0);
  windowSetTimeout(() => {
    runtime.forwardingEnabled = true;
    flushNativeCaptureBytes(runtime, event.sender);
  }, FFMPEG_STARTUP_FLUSH_DELAY_MS);

  return { ok: true, sessionId };
}

async function stopNativeMicrophoneCapture(
  event: IpcMainInvokeEvent,
  sessionId: string,
): Promise<boolean> {
  const runtime = activeCapture;
  if (!runtime || runtime.sessionId !== sessionId || runtime.ownerId !== event.sender.id) {
    return false;
  }

  await stopActiveCapture("requested");
  return true;
}

async function stopActiveCapture(reason: string): Promise<void> {
  const runtime = activeCapture;
  if (!runtime) {
    return;
  }

  runtime.stopping = true;
  const done = new Promise<void>((resolve) => {
    captureEvents.once(`ended:${runtime.sessionId}`, () => resolve());
    windowSetTimeout(resolve, 1500);
  });

  try {
    runtime.process.kill("SIGTERM");
  } catch (error) {
    console.warn(`[NativeMicrophone] failed to stop capture (${reason}).`, error);
  }

  await done;
  if (activeCapture === runtime) {
    activeCapture = null;
  }
}

function handleNativeCaptureBytes(
  runtime: NativeCaptureRuntime,
  sender: WebContents,
  chunk: Buffer,
): void {
  if (activeCapture !== runtime || runtime.stopping) {
    return;
  }

  const bytes = runtime.pendingBytes.length
    ? Buffer.concat([runtime.pendingBytes, chunk])
    : chunk;
  runtime.pendingBytes = bytes;
  resolveNativeCaptureStartup(runtime);
  if (!runtime.ready || !runtime.forwardingEnabled) {
    return;
  }

  flushNativeCaptureBytes(runtime, sender);
}

function flushNativeCaptureBytes(
  runtime: NativeCaptureRuntime,
  sender: WebContents,
): void {
  if (activeCapture !== runtime || runtime.stopping || !runtime.ready || !runtime.forwardingEnabled) {
    return;
  }

  const bytes = runtime.pendingBytes;
  let offset = 0;
  while (offset + FFMPEG_CHUNK_BYTES <= bytes.length) {
    const frame = bytes.subarray(offset, offset + FFMPEG_CHUNK_BYTES);
    offset += FFMPEG_CHUNK_BYTES;
    sender.send("desktop:native-microphone-chunk", {
      sessionId: runtime.sessionId,
      pcm16le: bufferToExactArrayBuffer(frame),
      sampleRate: FFMPEG_SAMPLE_RATE,
      channels: FFMPEG_CHANNELS,
    });
  }
  runtime.pendingBytes = offset < bytes.length ? bytes.subarray(offset) : Buffer.alloc(0);
}

function createNativeCaptureStartup(runtime: NativeCaptureRuntime): NativeCaptureStartup & { promise: Promise<void> } {
  let startup!: NativeCaptureStartup;
  const promise = new Promise<void>((resolve, reject) => {
    startup = {
      settled: false,
      timeout: windowSetTimeoutWithHandle(() => {
        failNativeCaptureStartup(runtime, "native_microphone_start_timeout");
      }, FFMPEG_STARTUP_READY_TIMEOUT_MS),
      resolve,
      reject: (error) => reject(new Error(error)),
    };
  });
  return Object.assign(startup, { promise });
}

function resolveNativeCaptureStartup(runtime: NativeCaptureRuntime): void {
  const startup = runtime.startup;
  if (!startup || startup.settled) {
    return;
  }

  startup.settled = true;
  clearTimeout(startup.timeout);
  startup.resolve();
}

function failNativeCaptureStartup(runtime: NativeCaptureRuntime, error: string): void {
  const startup = runtime.startup;
  if (!startup || startup.settled) {
    return;
  }

  startup.settled = true;
  clearTimeout(startup.timeout);
  startup.reject(error);
}

function appendNativeCaptureStderr(runtime: NativeCaptureRuntime, error: string): string {
  const stderr = runtime.stderrLines.join("\n").trim();
  if (!stderr) {
    return error;
  }
  return `${error}: ${stderr.slice(-500)}`;
}

function emitNativeCaptureError(
  runtime: NativeCaptureRuntime,
  sender: WebContents,
  error: string,
): void {
  sender.send("desktop:native-microphone-error", {
    sessionId: runtime.sessionId,
    error,
  });
}

function bufferToExactArrayBuffer(frame: Buffer): ArrayBuffer {
  const copy = new Uint8Array(frame.byteLength);
  copy.set(frame);
  return copy.buffer;
}

function selectNativeMicrophoneDevice(
  devices: readonly NativeMicrophoneDevice[],
  deviceId: string | null,
): NativeMicrophoneDevice | null {
  const normalized = typeof deviceId === "string" ? deviceId.trim() : "";
  if (!normalized) {
    return devices[0] ?? null;
  }

  return devices.find((device) => device.deviceId === normalized) ?? null;
}

function parseDirectShowAudioDevices(output: string): NativeMicrophoneDevice[] {
  const devices: NativeMicrophoneDevice[] = [];
  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const audioMatch = lines[index].match(/"(.+)"\s+\(audio\)/);
    if (!audioMatch) {
      continue;
    }

    const label = audioMatch[1].trim();
    const nextLine = lines[index + 1] ?? "";
    const alternativeNameMatch = nextLine.match(/Alternative name "(.+)"/);
    const alternativeName = alternativeNameMatch?.[1]?.trim() ?? "";
    devices.push({
      deviceId: alternativeName || `native:${label}`,
      label,
      alternativeName,
    });
  }
  return devices;
}

function cloneDevices(devices: readonly NativeMicrophoneDevice[]): NativeMicrophoneDevice[] {
  return devices.map((device) => ({ ...device }));
}

function runFfmpegForOutput(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) {
      reject(new Error("ffmpeg_not_found"));
      return;
    }

    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("exit", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function resolveFfmpegPath(): string | null {
  const envPath = process.env.FFMPEG_PATH?.trim();
  const envCandidate = resolveFfmpegExecutable(envPath);
  if (envCandidate) {
    return envCandidate;
  }

  const pathEntries = (process.env.PATH ?? "").split(delimiter);
  for (const entry of pathEntries) {
    const candidate = resolveFfmpegExecutable(entry);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function resolveFfmpegExecutable(candidatePath: string | undefined): string | null {
  const normalized = normalizeExecutablePathCandidate(candidatePath);
  if (!normalized) {
    return null;
  }

  const directFile = getExistingFilePath(normalized);
  if (directFile) {
    return directFile;
  }

  if (process.platform === "win32" && !normalized.toLowerCase().endsWith(".exe")) {
    const exeFile = getExistingFilePath(`${normalized}.exe`);
    if (exeFile) {
      return exeFile;
    }
  }

  const directoryFile = getExistingFilePath(join(normalized, "ffmpeg.exe"))
    ?? getExistingFilePath(join(normalized, "bin", "ffmpeg.exe"));
  if (directoryFile) {
    return directoryFile;
  }

  return null;
}

function normalizeExecutablePathCandidate(candidatePath: string | undefined): string {
  return (candidatePath ?? "").trim().replace(/^"(.+)"$/, "$1");
}

function getExistingFilePath(candidatePath: string): string | null {
  if (!candidatePath || !existsSync(candidatePath)) {
    return null;
  }

  try {
    return statSync(candidatePath).isFile() ? candidatePath : null;
  } catch {
    return null;
  }
}

function windowSetTimeout(callback: () => void, timeoutMs: number): void {
  setTimeout(callback, timeoutMs);
}

function windowSetTimeoutWithHandle(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(callback, timeoutMs);
}
