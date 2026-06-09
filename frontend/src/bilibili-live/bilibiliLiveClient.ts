import {
  extractDanmakuMessage,
  makeBilibiliAuthPacket,
  makeBilibiliHeartbeatPacket,
  parseBilibiliMessage,
} from "./bilibiliPacket.js";
import type {
  BilibiliDanmakuInfo,
  BilibiliDanmakuMessage,
  BilibiliLiveSettings,
} from "../types/bilibili-live.js";

const DEFAULT_HOST = {
  host: "broadcastlv.chat.bilibili.com",
  wssPort: 443,
};
const HEARTBEAT_INTERVAL_MS = 30_000;
const PROTO_NORMAL = 0;
const PROTO_DEFLATE = 2;
const PROTO_BROTLI = 3;

export interface BilibiliLiveClientStatus {
  connected: boolean;
  realRoomId: number | null;
  lastError: string;
  authReceived?: boolean;
  heartbeatReceived?: boolean;
  commandCount?: number;
  danmakuCount?: number;
  lastCommand?: string;
  protover?: number | null;
}

export interface BilibiliLiveClientOptions {
  settings: BilibiliLiveSettings;
  onDanmaku: (message: BilibiliDanmakuMessage) => void;
  onStatus: (status: BilibiliLiveClientStatus) => void;
}

export class BilibiliLiveClient {
  private readonly settings: BilibiliLiveSettings;
  private readonly onDanmaku: (message: BilibiliDanmakuMessage) => void;
  private readonly onStatus: (status: BilibiliLiveClientStatus) => void;
  private socket: WebSocket | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private stopped = false;
  private reconnectAttempts = 0;
  private currentInfo: BilibiliDanmakuInfo | null = null;
  private lastError = "";
  private authReceived = false;
  private heartbeatReceived = false;
  private commandCount = 0;
  private danmakuCount = 0;
  private lastCommand = "";
  private protover: number | null = null;

  constructor(options: BilibiliLiveClientOptions) {
    this.settings = options.settings;
    this.onDanmaku = options.onDanmaku;
    this.onStatus = options.onStatus;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.close();
    }
    this.emitStatus({ connected: false });
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      const info = await fetchDanmakuInfo(this.settings);
      if (this.stopped) {
        return;
      }
      this.currentInfo = info;
      const host = info.hosts[this.reconnectAttempts % info.hosts.length] ?? DEFAULT_HOST;
      const socket = new WebSocket(`wss://${host.host}:${host.wssPort}/sub`);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      this.resetDiagnostics();
      this.emitStatus({
        connected: false,
        realRoomId: info.realRoomId,
        lastError: "",
        protover: this.protover,
      });

      socket.onopen = () => {
        if (this.socket !== socket || this.stopped) {
          socket.close();
          return;
        }
        this.reconnectAttempts = 0;
        const authPayload = buildAuthPayload(info);
        this.protover = Number(authPayload.protover);
        this.emitStatus({ connected: false, protover: this.protover });
        socket.send(makeBilibiliAuthPacket(authPayload));
        this.clearHeartbeatTimer();
        this.heartbeatTimer = window.setInterval(() => {
          if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
            socket.send(makeBilibiliHeartbeatPacket());
          }
        }, HEARTBEAT_INTERVAL_MS);
      };

      socket.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) {
          return;
        }
        void this.handleBinaryMessage(event.data);
      };

      socket.onerror = () => {
        this.emitStatus({ connected: false, lastError: "Bilibili live WebSocket error." });
      };

      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null;
        }
        this.clearHeartbeatTimer();
        this.emitStatus({ connected: false });
        this.scheduleReconnect();
      };
    } catch (error) {
      this.emitStatus({
        connected: false,
        lastError: error instanceof Error ? error.message : "Bilibili live connect failed.",
      });
      this.scheduleReconnect();
    }
  }

  private async handleBinaryMessage(data: ArrayBuffer): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const message = await parseBilibiliMessage(data);
      if (this.stopped) {
        return;
      }
      if (
        message.authenticated
        || message.heartbeat
        || message.commands.length > 0
      ) {
        this.authReceived = this.authReceived || message.authenticated;
        this.heartbeatReceived = this.heartbeatReceived || message.heartbeat;
        this.commandCount += message.commands.length;
        const lastCommand = getLastCommandName(message.commands);
        if (lastCommand) {
          this.lastCommand = lastCommand;
        }
      }
      for (const command of message.commands) {
        const danmaku = extractDanmakuMessage(command);
        if (danmaku) {
          this.danmakuCount += 1;
          this.onDanmaku(danmaku);
        }
      }
      if (
        message.authenticated
        || message.heartbeat
        || message.commands.length > 0
      ) {
        this.emitStatus({ connected: true, lastError: "" });
      }
    } catch (error) {
      this.emitStatus({
        connected: false,
        lastError: error instanceof Error ? error.message : "Bilibili live packet parse failed.",
      });
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1_000 * this.reconnectAttempts);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private emitStatus(patch: Partial<BilibiliLiveClientStatus>): void {
    if (patch.lastError !== undefined) {
      this.lastError = patch.lastError;
    }
    this.onStatus({
      connected: patch.connected ?? false,
      realRoomId: patch.realRoomId ?? this.currentInfo?.realRoomId ?? null,
      lastError: this.lastError,
      authReceived: patch.authReceived ?? this.authReceived,
      heartbeatReceived: patch.heartbeatReceived ?? this.heartbeatReceived,
      commandCount: patch.commandCount ?? this.commandCount,
      danmakuCount: patch.danmakuCount ?? this.danmakuCount,
      lastCommand: patch.lastCommand ?? this.lastCommand,
      protover: patch.protover ?? this.protover,
    });
  }

  private resetDiagnostics(): void {
    this.authReceived = false;
    this.heartbeatReceived = false;
    this.commandCount = 0;
    this.danmakuCount = 0;
    this.lastCommand = "";
    this.protover = null;
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer === null) {
      return;
    }
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) {
      return;
    }
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

async function fetchDanmakuInfo(settings: BilibiliLiveSettings): Promise<BilibiliDanmakuInfo> {
  const bridge = window.ag99desktop?.getBilibiliDanmakuInfo;
  if (!bridge) {
    throw new Error("Bilibili live bridge is unavailable.");
  }
  const result = await bridge(settings);
  if (!result.ok) {
    throw new Error(result.error || "Bilibili live connect failed.");
  }
  return {
    ...result.info,
    hosts: result.info.hosts.length ? result.info.hosts : [DEFAULT_HOST],
  };
}

function getLastCommandName(commands: readonly Record<string, unknown>[]): string {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    const cmd = typeof command.cmd === "string" ? command.cmd.trim() : "";
    if (cmd) {
      return cmd;
    }
  }
  return "";
}

function buildAuthPayload(info: BilibiliDanmakuInfo): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    uid: info.uid,
    roomid: info.realRoomId,
    protover: resolvePreferredProtover(),
    platform: "web",
    type: 2,
    buvid: info.buvid,
  };
  if (info.token) {
    payload.key = info.token;
  }
  return payload;
}

function resolvePreferredProtover(): number {
  if (canCreateDecompressionStream("br")) {
    return PROTO_BROTLI;
  }
  if (canCreateDecompressionStream("deflate")) {
    return PROTO_DEFLATE;
  }
  return PROTO_NORMAL;
}

function canCreateDecompressionStream(format: "br" | "deflate"): boolean {
  const ctor = (globalThis as {
    DecompressionStream?: new (format: string) => DecompressionStream;
  }).DecompressionStream;
  if (typeof ctor !== "function") {
    return false;
  }
  try {
    new ctor(format);
    return true;
  } catch {
    return false;
  }
}

function filterWbiValue(value: string): string {
  return value.replace(/[!'()*]/g, "");
}

async function md5Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return md5Bytes(bytes)
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function md5Bytes(input: Uint8Array): number[] {
  const originalBitLength = input.length * 8;
  const paddedLength = (((input.length + 8) >> 6) + 1) * 64;
  const words = new Uint32Array(paddedLength / 4);
  for (let index = 0; index < input.length; index += 1) {
    words[index >> 2] |= input[index] << ((index % 4) * 8);
  }
  words[input.length >> 2] |= 0x80 << ((input.length % 4) * 8);
  words[words.length - 2] = originalBitLength & 0xffffffff;
  words[words.length - 1] = Math.floor(originalBitLength / 0x100000000);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let i = 0; i < words.length; i += 16) {
    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;

    a = ff(a, b, c, d, words[i + 0], 7, 0xd76aa478);
    d = ff(d, a, b, c, words[i + 1], 12, 0xe8c7b756);
    c = ff(c, d, a, b, words[i + 2], 17, 0x242070db);
    b = ff(b, c, d, a, words[i + 3], 22, 0xc1bdceee);
    a = ff(a, b, c, d, words[i + 4], 7, 0xf57c0faf);
    d = ff(d, a, b, c, words[i + 5], 12, 0x4787c62a);
    c = ff(c, d, a, b, words[i + 6], 17, 0xa8304613);
    b = ff(b, c, d, a, words[i + 7], 22, 0xfd469501);
    a = ff(a, b, c, d, words[i + 8], 7, 0x698098d8);
    d = ff(d, a, b, c, words[i + 9], 12, 0x8b44f7af);
    c = ff(c, d, a, b, words[i + 10], 17, 0xffff5bb1);
    b = ff(b, c, d, a, words[i + 11], 22, 0x895cd7be);
    a = ff(a, b, c, d, words[i + 12], 7, 0x6b901122);
    d = ff(d, a, b, c, words[i + 13], 12, 0xfd987193);
    c = ff(c, d, a, b, words[i + 14], 17, 0xa679438e);
    b = ff(b, c, d, a, words[i + 15], 22, 0x49b40821);

    a = gg(a, b, c, d, words[i + 1], 5, 0xf61e2562);
    d = gg(d, a, b, c, words[i + 6], 9, 0xc040b340);
    c = gg(c, d, a, b, words[i + 11], 14, 0x265e5a51);
    b = gg(b, c, d, a, words[i + 0], 20, 0xe9b6c7aa);
    a = gg(a, b, c, d, words[i + 5], 5, 0xd62f105d);
    d = gg(d, a, b, c, words[i + 10], 9, 0x02441453);
    c = gg(c, d, a, b, words[i + 15], 14, 0xd8a1e681);
    b = gg(b, c, d, a, words[i + 4], 20, 0xe7d3fbc8);
    a = gg(a, b, c, d, words[i + 9], 5, 0x21e1cde6);
    d = gg(d, a, b, c, words[i + 14], 9, 0xc33707d6);
    c = gg(c, d, a, b, words[i + 3], 14, 0xf4d50d87);
    b = gg(b, c, d, a, words[i + 8], 20, 0x455a14ed);
    a = gg(a, b, c, d, words[i + 13], 5, 0xa9e3e905);
    d = gg(d, a, b, c, words[i + 2], 9, 0xfcefa3f8);
    c = gg(c, d, a, b, words[i + 7], 14, 0x676f02d9);
    b = gg(b, c, d, a, words[i + 12], 20, 0x8d2a4c8a);

    a = hh(a, b, c, d, words[i + 5], 4, 0xfffa3942);
    d = hh(d, a, b, c, words[i + 8], 11, 0x8771f681);
    c = hh(c, d, a, b, words[i + 11], 16, 0x6d9d6122);
    b = hh(b, c, d, a, words[i + 14], 23, 0xfde5380c);
    a = hh(a, b, c, d, words[i + 1], 4, 0xa4beea44);
    d = hh(d, a, b, c, words[i + 4], 11, 0x4bdecfa9);
    c = hh(c, d, a, b, words[i + 7], 16, 0xf6bb4b60);
    b = hh(b, c, d, a, words[i + 10], 23, 0xbebfbc70);
    a = hh(a, b, c, d, words[i + 13], 4, 0x289b7ec6);
    d = hh(d, a, b, c, words[i + 0], 11, 0xeaa127fa);
    c = hh(c, d, a, b, words[i + 3], 16, 0xd4ef3085);
    b = hh(b, c, d, a, words[i + 6], 23, 0x04881d05);
    a = hh(a, b, c, d, words[i + 9], 4, 0xd9d4d039);
    d = hh(d, a, b, c, words[i + 12], 11, 0xe6db99e5);
    c = hh(c, d, a, b, words[i + 15], 16, 0x1fa27cf8);
    b = hh(b, c, d, a, words[i + 2], 23, 0xc4ac5665);

    a = ii(a, b, c, d, words[i + 0], 6, 0xf4292244);
    d = ii(d, a, b, c, words[i + 7], 10, 0x432aff97);
    c = ii(c, d, a, b, words[i + 14], 15, 0xab9423a7);
    b = ii(b, c, d, a, words[i + 5], 21, 0xfc93a039);
    a = ii(a, b, c, d, words[i + 12], 6, 0x655b59c3);
    d = ii(d, a, b, c, words[i + 3], 10, 0x8f0ccc92);
    c = ii(c, d, a, b, words[i + 10], 15, 0xffeff47d);
    b = ii(b, c, d, a, words[i + 1], 21, 0x85845dd1);
    a = ii(a, b, c, d, words[i + 8], 6, 0x6fa87e4f);
    d = ii(d, a, b, c, words[i + 15], 10, 0xfe2ce6e0);
    c = ii(c, d, a, b, words[i + 6], 15, 0xa3014314);
    b = ii(b, c, d, a, words[i + 13], 21, 0x4e0811a1);
    a = ii(a, b, c, d, words[i + 4], 6, 0xf7537e82);
    d = ii(d, a, b, c, words[i + 11], 10, 0xbd3af235);
    c = ii(c, d, a, b, words[i + 2], 15, 0x2ad7d2bb);
    b = ii(b, c, d, a, words[i + 9], 21, 0xeb86d391);

    a = add32(a, aa);
    b = add32(b, bb);
    c = add32(c, cc);
    d = add32(d, dd);
  }

  return [a, b, c, d].flatMap((word) => [
    word & 0xff,
    (word >>> 8) & 0xff,
    (word >>> 16) & 0xff,
    (word >>> 24) & 0xff,
  ]);
}

function cmn(q: number, a: number, b: number, x: number, s: number, t: number): number {
  return add32(rotateLeft(add32(add32(a, q), add32(x, t)), s), b);
}

function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}

function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}

function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}

function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number): number {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

function add32(left: number, right: number): number {
  return (left + right) >>> 0;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function extractCookie(cookie: string, name: string): string {
  const parts = cookie.split(";").map((part) => part.trim());
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return "";
}

function extractNumericCookie(cookie: string, name: string): number | null {
  const value = extractCookie(cookie, name);
  if (!value) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function createFallbackBuvid(): string {
  const random = Math.random().toString(36).slice(2, 12).toUpperCase();
  return `AG99LIVE${random}${Date.now().toString(36).toUpperCase()}`;
}

export const BILIBILI_LIVE_CLIENT_TEST_ONLY = {
  extractCookie,
  extractNumericCookie,
  filterWbiValue,
  buildAuthPayload,
  getLastCommandName,
  md5Hex,
  resolvePreferredProtover,
};
