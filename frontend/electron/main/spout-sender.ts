import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

const FRAME_MAGIC = 0x4147_3939;
const FRAME_HEADER_BYTES = 16;
const MAX_FRAME_DIMENSION = 8192;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

export const AG99LIVE_SPOUT_SENDER_NAME = "AG99live.Live2D";

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
  private stdoutBuffer = "";
  private stderrBuffer = "";

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
        this.writeBlocked = false;
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
      });
    } catch (error) {
      this.handleProcessFailure(error);
    }
  }

  publishFrame(width: unknown, height: unknown, rgba: unknown): void {
    if (
      !isFrameDimension(width)
      || !isFrameDimension(height)
      || !(rgba instanceof Uint8Array)
      || !this.isValidFrame(width, height, rgba)
    ) {
      return;
    }
    if (!this.process && !this.stopped && !this.unavailable) {
      this.start();
    }
    const child = this.process;
    if (!child || !this.ready || this.writeBlocked || child.stdin.destroyed) {
      return;
    }

    const pixels = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
    header.writeUInt32LE(FRAME_MAGIC, 0);
    header.writeUInt32LE(width, 4);
    header.writeUInt32LE(height, 8);
    header.writeUInt32LE(pixels.byteLength, 12);

    try {
      child.stdin.cork();
      const acceptedHeader = child.stdin.write(header);
      const acceptedPixels = child.stdin.write(pixels);
      child.stdin.uncork();
      if (!acceptedHeader || !acceptedPixels) {
        this.writeBlocked = true;
      }
    } catch (error) {
      child.stdin.uncork();
      this.handleProcessFailure(error);
    }
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.writeBlocked = false;
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
        console.info(`[Spout] Sender ready: ${AG99LIVE_SPOUT_SENDER_NAME}`);
        continue;
      }
      const log = isError ? console.warn : console.info;
      log(`[Spout] ${line}`);
    }
  }

  private handleProcessFailure(error: unknown): void {
    this.ready = false;
    this.process = null;
    this.writeBlocked = false;
    if (this.unavailable || this.stopped) {
      return;
    }
    this.unavailable = true;
    console.warn("[Spout] Sender is unavailable. Live2D Spout output is disabled.", error);
  }
}
