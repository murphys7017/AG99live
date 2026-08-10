import type { BilibiliDanmakuMessage } from "../types/bilibili-live.js";

const HEADER_SIZE = 16;
const PROTO_NORMAL = 0;
const PROTO_DEFLATE = 2;
const PROTO_BROTLI = 3;
const OP_HEARTBEAT = 2;
const OP_HEARTBEAT_REPLY = 3;
const OP_SEND_MSG_REPLY = 5;
const OP_AUTH = 7;
const OP_AUTH_REPLY = 8;

export interface BilibiliPacket {
  protocolVersion: number;
  operation: number;
  body: Uint8Array;
}

export interface BilibiliMessageParseResult {
  authenticated: boolean;
  heartbeat: boolean;
  commands: Record<string, unknown>[];
}

export function makeBilibiliAuthPacket(payload: Record<string, unknown>): ArrayBuffer {
  return makePacket(encodeJson(payload), OP_AUTH);
}

export function makeBilibiliHeartbeatPacket(): ArrayBuffer {
  return makePacket(encodeJson({}), OP_HEARTBEAT);
}

export async function parseBilibiliPackets(data: ArrayBuffer): Promise<BilibiliPacket[]> {
  const bytes = new Uint8Array(data);
  const parsed: BilibiliPacket[] = [];
  await parsePacketBytes(bytes, parsed);
  return parsed;
}

export async function parseBilibiliCommands(data: ArrayBuffer): Promise<Record<string, unknown>[]> {
  return (await parseBilibiliMessage(data)).commands;
}

export async function parseBilibiliMessage(data: ArrayBuffer): Promise<BilibiliMessageParseResult> {
  const packets = await parseBilibiliPackets(data);
  const commands: Record<string, unknown>[] = [];
  let authenticated = false;
  let heartbeat = false;
  for (const packet of packets) {
    if (packet.operation === OP_SEND_MSG_REPLY) {
      commands.push(...parseJsonCommands(packet.body));
      continue;
    }
    if (packet.operation === OP_AUTH_REPLY) {
      const [authReply] = parseJsonCommands(packet.body);
      if (authReply && Number(authReply.code) !== 0) {
        throw new Error(`Bilibili live auth failed: code=${String(authReply.code)}`);
      }
      authenticated = true;
      continue;
    }
    if (packet.operation === OP_HEARTBEAT_REPLY) {
      heartbeat = true;
      continue;
    }
  }
  return { authenticated, heartbeat, commands };
}

export function extractDanmakuMessage(command: Record<string, unknown>): BilibiliDanmakuMessage | null {
  const cmd = String(command.cmd ?? "");
  if (!cmd.startsWith("DANMU_MSG")) {
    return null;
  }
  const info = command.info;
  if (!Array.isArray(info)) {
    return null;
  }
  const text = typeof info[1] === "string" ? info[1].trim() : "";
  if (!text) {
    return null;
  }
  const userInfo = Array.isArray(info[2]) ? info[2] : [];
  const uid = Number(userInfo[0]);
  const uname = typeof userInfo[1] === "string" ? userInfo[1].trim() : "";
  return {
    uid: Number.isFinite(uid) ? uid : 0,
    uname: uname || "观众",
    text,
    timestamp: Date.now(),
  };
}

async function parsePacketBytes(bytes: Uint8Array, output: BilibiliPacket[]): Promise<void> {
  let offset = 0;
  while (offset + HEADER_SIZE <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const packetLength = view.getUint32(0);
    const headerLength = view.getUint16(4);
    const protocolVersion = view.getUint16(6);
    const operation = view.getUint32(8);
    if (
      packetLength < headerLength
      || headerLength < HEADER_SIZE
      || offset + packetLength > bytes.byteLength
    ) {
      break;
    }

    const body = bytes.slice(offset + headerLength, offset + packetLength);
    if (operation === OP_SEND_MSG_REPLY && protocolVersion === PROTO_BROTLI) {
      const decompressed = await decompressBrotli(body);
      if (decompressed) {
        await parsePacketBytes(decompressed, output);
      }
    } else if (operation === OP_SEND_MSG_REPLY && protocolVersion === PROTO_DEFLATE) {
      const decompressed = await decompressDeflate(body);
      if (decompressed) {
        await parsePacketBytes(decompressed, output);
      }
    } else {
      output.push({ protocolVersion, operation, body });
    }

    offset += packetLength;
  }
}

function makePacket(body: Uint8Array, operation: number): ArrayBuffer {
  const packet = new ArrayBuffer(HEADER_SIZE + body.byteLength);
  const view = new DataView(packet);
  view.setUint32(0, HEADER_SIZE + body.byteLength);
  view.setUint16(4, HEADER_SIZE);
  view.setUint16(6, 1);
  view.setUint32(8, operation);
  view.setUint32(12, 1);
  new Uint8Array(packet, HEADER_SIZE).set(body);
  return packet;
}

function encodeJson(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function parseJsonCommands(body: Uint8Array): Record<string, unknown>[] {
  if (body.byteLength === 0) {
    return [];
  }
  const decoded = new TextDecoder().decode(body).trim();
  if (!decoded) {
    return [];
  }
  const parsed = JSON.parse(decoded) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? [parsed as Record<string, unknown>]
    : [];
}

async function decompressDeflate(body: Uint8Array): Promise<Uint8Array | null> {
  const ds = getDecompressionStream("deflate");
  if (!ds) {
    console.warn("[BilibiliLive] Deflate packet received but DecompressionStream is unavailable.");
    return null;
  }
  return readStreamToBytes(bytesToBlob(body).stream().pipeThrough(ds));
}

async function decompressBrotli(body: Uint8Array): Promise<Uint8Array | null> {
  const ds = getDecompressionStream("br");
  if (!ds) {
    console.warn("[BilibiliLive] Brotli packet received but DecompressionStream('br') is unavailable.");
    return null;
  }
  return readStreamToBytes(bytesToBlob(body).stream().pipeThrough(ds));
}

function getDecompressionStream(format: "deflate" | "br"): DecompressionStream | null {
  const ctor = (globalThis as {
    DecompressionStream?: new (format: string) => DecompressionStream;
  }).DecompressionStream;
  if (typeof ctor !== "function") {
    return null;
  }
  try {
    return new ctor(format);
  } catch {
    return null;
  }
}

function bytesToBlob(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer]);
}

async function readStreamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
