import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import net from "node:net";

interface Esp32BridgeConfig {
  host: string;
  port: number;
  timeoutSeconds: number;
}

interface Esp32SendResult {
  ok: boolean;
  error?: string;
}

const QUEUE_LIMIT = 8;
const DEFAULT_TIMEOUT_SECONDS = 8;
class Esp32DisplayBridge {
  private socket: net.Socket | null = null;
  private config: Esp32BridgeConfig | null = null;
  private queue: Buffer[] = [];
  private processing = false;
  private connected = false;
  private closing = false;
  private lastError = "";

  isConnected(): boolean {
    return this.connected;
  }

  lastKnownError(): string {
    return this.lastError;
  }

  async start(config: Esp32BridgeConfig): Promise<void> {
    console.info(
      `[Esp32Display] start requested host=${config.host} port=${config.port} timeout=${config.timeoutSeconds}s`,
    );
    this.closing = true;
    await this.disconnect(false);
    this.config = config;
    this.closing = false;
    this.lastError = "";
    await this.connect();
    console.info(`[Esp32Display] start resolved connected=${this.connected}`);
  }

  async stop(): Promise<void> {
    console.info("[Esp32Display] stop requested");
    this.closing = true;
    this.queue = [];
    await this.disconnect(true);
  }

  enqueueFrame(jpegBytes: Uint8Array): Esp32SendResult {
    if (!this.connected || !this.socket) {
      return { ok: false, error: "not_connected" };
    }
    if (this.queue.length >= QUEUE_LIMIT) {
      this.queue.shift();
    }
    this.queue.push(Buffer.from(jpegBytes));
    void this.drain();
    return { ok: true };
  }

  private async drain(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      let drained = 0;
      while (this.queue.length > 0 && this.connected) {
        const frame = this.queue.shift();
        if (!frame) {
          break;
        }
        const ok = await this.writeAndAwaitAck(frame);
        drained += 1;
        if (!ok) {
          console.warn(`[Esp32Display] frame ${drained} send failed, pausing drain`);
          break;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private connect(): Promise<void> {
    if (!this.config) {
      return Promise.reject(new Error("missing_config"));
    }
    const { host, port, timeoutSeconds } = this.config;
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      sock.setTimeout(timeoutSeconds * 1000);
      sock.setNoDelay(true);
      console.info(`[Esp32Display] opening TCP ${host}:${port}`);
      let settled = false;

      const onError = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.connected = false;
        this.socket = null;
        this.lastError = err.message;
        console.warn(`[Esp32Display] TCP error: ${err.message}`);
        sock.destroy();
        broadcastStatus(this.connected, this.lastError);
        reject(err);
      };

      const onConnect = () => {
        console.info("[Esp32Display] TCP connected, waiting for device 'ready' greeting");
        sock.once("data", () => {
          if (settled) {
            return;
          }
          settled = true;
          sock.setTimeout(0);
          cleanup();
          this.socket = sock;
          this.connected = true;
          this.lastError = "";
          console.info("[Esp32Display] device sent ready, bridge ready");
          broadcastStatus(this.connected, this.lastError);
          resolve();
        });
      };

      const onTimeout = () => {
        const err = new Error(`connection_timeout_${timeoutSeconds}s`);
        console.warn(`[Esp32Display] ${err.message} (no 'ready' from device)`);
        onError(err);
      };

      const onClose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        if (!this.closing && (wasConnected || !settled)) {
          settled = true;
          this.lastError = "connection_closed";
          console.warn("[Esp32Display] connection closed unexpectedly");
          broadcastStatus(this.connected, this.lastError);
          reject(new Error(this.lastError));
        }
      };

      const cleanup = () => {
        sock.off("error", onError);
        sock.off("connect", onConnect);
        sock.off("timeout", onTimeout);
      };

      sock.once("error", onError);
      sock.once("connect", onConnect);
      sock.once("timeout", onTimeout);
      sock.on("close", onClose);
    });
  }

  private disconnect(shouldBroadcast: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const sock = this.socket;
      this.socket = null;
      this.connected = false;
      this.processing = false;
      this.queue = [];
      if (shouldBroadcast) {
        this.lastError = "";
        broadcastStatus(false, "");
      }
      if (!sock) {
        resolve();
        return;
      }
      const finalize = () => {
        resolve();
      };
      sock.once("close", finalize);
      sock.destroy();
      setTimeout(finalize, 250).unref();
    });
  }

  private writeAndAwaitAck(frame: Buffer): Promise<boolean> {
    const sock = this.socket;
    if (!sock || !this.connected) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timeoutMs = Math.max(
        1,
        this.config?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      ) * 1000;
      const timer = setTimeout(() => {
        finish(false, `ack_timeout_${timeoutMs / 1000}s`);
      }, timeoutMs);
      timer.unref();
      const finish = (ok: boolean, err?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        sock.off("data", onData);
        sock.off("error", onError);
        sock.off("close", onClose);
        if (!ok) {
          this.lastError = err ?? "write_failed";
          this.connected = false;
          this.socket = null;
          this.queue = [];
          sock.destroy();
          broadcastStatus(this.connected, this.lastError);
        }
        resolve(ok);
      };
      const onData = () => finish(true);
      const onError = (err: Error) => finish(false, err.message);
      const onClose = () => finish(false, "connection_closed");
      sock.once("data", onData);
      sock.once("error", onError);
      sock.once("close", onClose);
      sock.write(frame, (err) => {
        if (err) {
          finish(false, err.message);
        }
      });
    });
  }
}

let bridge: Esp32DisplayBridge | null = null;

function getBridge(): Esp32DisplayBridge {
  if (!bridge) {
    bridge = new Esp32DisplayBridge();
  }
  return bridge;
}

function broadcastStatus(connected: boolean, error: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue;
    }
    win.webContents.send("esp32-display:status", { connected, error });
  }
}

export function registerEsp32DisplayIpc(): void {
  ipcMain.handle(
    "esp32-display:start",
    async (
      _event: IpcMainInvokeEvent,
      payload: { host: string; port: number; timeoutSeconds?: number },
    ): Promise<{ ok: boolean; error?: string }> => {
      const target = getBridge();
      try {
        await target.start({
          host: payload.host,
          port: payload.port,
          timeoutSeconds: payload.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        });
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  );

  ipcMain.handle("esp32-display:stop", async (): Promise<{ ok: boolean }> => {
    if (bridge) {
      await bridge.stop();
    }
    return { ok: true };
  });

  ipcMain.handle(
    "esp32-display:send-frame",
    async (
      _event: IpcMainInvokeEvent,
      payload: { jpeg: Uint8Array },
    ): Promise<Esp32SendResult> => {
      if (!bridge) {
        return { ok: false, error: "not_started" };
      }
      return bridge.enqueueFrame(payload.jpeg);
    },
  );

  ipcMain.handle("esp32-display:status", async (): Promise<{ connected: boolean; error: string }> => {
    if (!bridge) {
      return { connected: false, error: "" };
    }
    return {
      connected: bridge.isConnected(),
      error: bridge.lastKnownError(),
    };
  });
}

export async function shutdownEsp32DisplayBridge(): Promise<void> {
  if (bridge) {
    await bridge.stop();
    bridge = null;
  }
}
