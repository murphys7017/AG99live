import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import type { DesktopSpoutSenderStatus } from "../../src/types/desktop";

const FRAME_MAGIC = 0x4147_3939;
const FRAME_HEADER_BYTES = 16;
const MAX_FRAME_DIMENSION = 8192;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const STATS_INTERVAL_MS = 10_000;

export const AG99LIVE_SPOUT_SENDER_NAME = "AG99live.Live2D";

interface SpoutSenderStats {
  receivedFrames: number;
  pipeQueuedFrames: number;
  droppedInvalidFrames: number;
  droppedNotReadyFrames: number;
  droppedBackpressureFrames: number;
  droppedUnavailableFrames: number;
  pipeBytes: number;
  writeCallMs: number;
  maxWriteCallMs: number;
}

function createEmptyStats(): SpoutSenderStats {
  return {
    receivedFrames: 0,
    pipeQueuedFrames: 0,
    droppedInvalidFrames: 0,
    droppedNotReadyFrames: 0,
    droppedBackpressureFrames: 0,
    droppedUnavailableFrames: 0,
    pipeBytes: 0,
    writeCallMs: 0,
    maxWriteCallMs: 0,
  };
}

function isFrameDimension(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isInteger(value)
    && value > 0
    && value <= MAX_FRAME_DIMENSION
  );
}

export class SpoutSender {
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private stopped = false;
  private unavailable = false;
  private writeBlocked = false;
  private statusRevision = 0;
  private lastStatusKey = "false:false:false";
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stats = createEmptyStats();
  private statsWindowStartedAt = performance.now();

  constructor(
    private readonly onStatusChange: (status: DesktopSpoutSenderStatus) => void = () => {},
  ) {}

  getStatus(): DesktopSpoutSenderStatus {
    return {
      ready: this.ready,
      writeBlocked: this.writeBlocked,
      unavailable: this.unavailable,
      canPublish: this.ready && !this.writeBlocked,
      revision: this.statusRevision,
    };
  }

  start(): void {
    if (process.platform !== "win32" || this.stopped || this.unavailable || this.process) {
      return;
    }

    const executablePath = this.resolveExecutablePath();
    try {
      const child = spawn(executablePath, ["--sender", AG99LIVE_SPOUT_SENDER_NAME], {
        cwd: path.dirname(executablePath),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.process = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.handleOutput(chunk, false));
      child.stderr.on("data", (chunk: string) => this.handleOutput(chunk, true));
      child.stdin.on("drain", () => {
        this.setWriteBlocked(false);
      });
      child.stdin.on("error", (error) => this.handleProcessFailure(error));
      child.on("error", (error) => this.handleProcessFailure(error));
      child.once("exit", (code, signal) => {
        if (this.process !== child) {
          return;
        }
        this.process = null;
        this.ready = false;
        this.writeBlocked = false;
        if (!this.stopped) {
          this.unavailable = true;
          console.warn(
            `[Spout] Sender exited before desktop shutdown (code=${code ?? "none"}, signal=${signal ?? "none"}).`,
          );
        }
        this.notifyStatusChange();
      });
    } catch (error) {
      this.handleProcessFailure(error);
    }
  }

  publishFrame(width: unknown, height: unknown, rgba: unknown): void {
    this.stats.receivedFrames += 1;
    if (
      !isFrameDimension(width)
      || !isFrameDimension(height)
      || !(rgba instanceof Uint8Array)
      || !this.isValidFrame(width, height, rgba)
    ) {
      this.stats.droppedInvalidFrames += 1;
      this.reportStatsIfDue();
      return;
    }
    if (!this.process && !this.stopped && !this.unavailable) {
      this.start();
    }
    const child = this.process;
    if (this.writeBlocked) {
      this.stats.droppedBackpressureFrames += 1;
      this.reportStatsIfDue();
      return;
    }
    if (!child || child.stdin.destroyed || this.unavailable || this.stopped) {
      this.stats.droppedUnavailableFrames += 1;
      this.reportStatsIfDue();
      return;
    }
    if (!this.ready) {
      this.stats.droppedNotReadyFrames += 1;
      this.reportStatsIfDue();
      return;
    }

    const pixels = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
    header.writeUInt32LE(FRAME_MAGIC, 0);
    header.writeUInt32LE(width, 4);
    header.writeUInt32LE(height, 8);
    header.writeUInt32LE(pixels.byteLength, 12);

    const writeStartedAt = performance.now();
    try {
      child.stdin.cork();
      const acceptedHeader = child.stdin.write(header);
      const acceptedPixels = child.stdin.write(pixels);
      child.stdin.uncork();
      const writeCallMs = performance.now() - writeStartedAt;
      this.stats.pipeQueuedFrames += 1;
      this.stats.pipeBytes += FRAME_HEADER_BYTES + pixels.byteLength;
      this.stats.writeCallMs += writeCallMs;
      this.stats.maxWriteCallMs = Math.max(this.stats.maxWriteCallMs, writeCallMs);
      if (!acceptedHeader || !acceptedPixels) {
        this.setWriteBlocked(true);
      }
    } catch (error) {
      child.stdin.uncork();
      this.handleProcessFailure(error);
    }
    this.reportStatsIfDue();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.writeBlocked = false;
    this.notifyStatusChange();
    this.reportStatsIfDue(true);
    const child = this.process;
    this.process = null;
    if (!child || child.killed) {
      return;
    }
    child.stdin.end();
    const killTimer = setTimeout(() => {
      if (!child.killed) {
        child.kill();
      }
    }, 1000);
    child.once("exit", () => clearTimeout(killTimer));
  }

  private resolveExecutablePath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "spout", "AG99liveSpoutSender.exe");
    }
    return path.resolve(__dirname, "../../resources/spout/AG99liveSpoutSender.exe");
  }

  private isValidFrame(width: number, height: number, rgba: Uint8Array): boolean {
    const requiredBytes = width * height * 4;
    return requiredBytes <= MAX_FRAME_BYTES && rgba.byteLength === requiredBytes;
  }

  private handleOutput(chunk: string, isError: boolean): void {
    const buffer = isError ? this.stderrBuffer : this.stdoutBuffer;
    const lines = `${buffer}${chunk}`.split(/\r?\n/);
    const trailing = lines.pop() ?? "";
    if (isError) {
      this.stderrBuffer = trailing;
    } else {
      this.stdoutBuffer = trailing;
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (line === "ready") {
        this.ready = true;
        this.notifyStatusChange();
        console.info(`[Spout] Sender ready: ${AG99LIVE_SPOUT_SENDER_NAME}`);
        continue;
      }
      if (!isError && line.startsWith("stats ")) {
        console.info(`[Spout] Native ${line}`);
        continue;
      }
      const log = isError ? console.warn : console.info;
      log(`[Spout] ${line}`);
    }
  }

  private setWriteBlocked(blocked: boolean): void {
    if (this.writeBlocked === blocked) {
      return;
    }
    this.writeBlocked = blocked;
    this.notifyStatusChange();
  }

  private notifyStatusChange(): void {
    const key = `${this.ready}:${this.writeBlocked}:${this.unavailable}`;
    if (key === this.lastStatusKey) {
      return;
    }
    this.lastStatusKey = key;
    this.statusRevision += 1;
    this.onStatusChange(this.getStatus());
  }

  private reportStatsIfDue(force = false, now = performance.now()): void {
    const elapsedMs = now - this.statsWindowStartedAt;
    if (!force && elapsedMs < STATS_INTERVAL_MS) {
      return;
    }
    const stats = this.stats;
    if (stats.receivedFrames > 0) {
      const averageWriteCallMs = stats.pipeQueuedFrames > 0
        ? stats.writeCallMs / stats.pipeQueuedFrames
        : 0;
      console.info(
        "[Spout] Main IPC received=%d pipe_queued=%d dropped_not_ready=%d dropped_backpressure=%d dropped_unavailable=%d dropped_invalid=%d pipe_fps=%s pipe_bytes=%d write_call_avg_ms=%s write_call_max_ms=%s",
        stats.receivedFrames,
        stats.pipeQueuedFrames,
        stats.droppedNotReadyFrames,
        stats.droppedBackpressureFrames,
        stats.droppedUnavailableFrames,
        stats.droppedInvalidFrames,
        (stats.pipeQueuedFrames * 1000 / Math.max(1, elapsedMs)).toFixed(1),
        stats.pipeBytes,
        averageWriteCallMs.toFixed(2),
        stats.maxWriteCallMs.toFixed(2),
      );
    }
    this.stats = createEmptyStats();
    this.statsWindowStartedAt = now;
  }

  private handleProcessFailure(error: unknown): void {
    this.ready = false;
    this.process = null;
    this.writeBlocked = false;
    if (this.unavailable || this.stopped) {
      this.notifyStatusChange();
      return;
    }
    this.unavailable = true;
    this.notifyStatusChange();
    console.warn("[Spout] Sender is unavailable. Live2D Spout output is disabled.", error);
  }
}
