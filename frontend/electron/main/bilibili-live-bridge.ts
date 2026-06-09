import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type {
  BilibiliDanmakuHost,
  BilibiliDanmakuInfo,
  BilibiliLiveSettings,
} from "../../src/types/bilibili-live";

const ROOM_INFO_URL = "https://api.live.bilibili.com/room/v1/Room/get_info";
const DANMAKU_INFO_URL =
  "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
const WBI_INIT_URL = "https://api.bilibili.com/x/web-interface/nav";
const DEFAULT_HOST: BilibiliDanmakuHost = {
  host: "broadcastlv.chat.bilibili.com",
  wssPort: 443,
};
const BILIBILI_WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const DANMAKU_WBI_DEVICE_PARAMS: Record<string, string> = {
  dm_img_list: "[]",
  dm_img_str: "V2ViR0wgMS",
  dm_cover_img_str:
    "QU5HTEUgKEludGVsLCBJbnRlbChSKSBIRCBHcmFwaGljcyBEaXJlY3QzRDExIHZzXzVfMCBwc181XzApLCBvciBzaW1pbGFyR29vZ2xlIEluYy4gKEludGVsKQ",
};
const WBI_KEY_INDEX_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
] as const;

interface DanmakuServerConfig {
  token: string;
  hosts: BilibiliDanmakuHost[];
}

export function registerBilibiliLiveIpc(): void {
  ipcMain.handle(
    "bilibili-live:get-danmaku-info",
    async (
      _event: IpcMainInvokeEvent,
      settings: BilibiliLiveSettings,
    ): Promise<
      | { ok: true; info: BilibiliDanmakuInfo }
      | { ok: false; error: string }
    > => {
      try {
        return {
          ok: true,
          info: await fetchDanmakuInfo(settings),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Bilibili live connect failed.",
        };
      }
    },
  );
}

async function fetchDanmakuInfo(settings: BilibiliLiveSettings): Promise<BilibiliDanmakuInfo> {
  const roomId = Number(settings.roomId);
  if (!Number.isFinite(roomId) || roomId <= 0) {
    throw new Error("Bilibili live room ID is required.");
  }

  const cookie = normalizeCookie(settings.cookie);
  const realRoomId = await fetchRealRoomId(roomId, cookie);
  const uid = extractNumericCookie(settings.cookie, "DedeUserID") ?? 0;
  const buvid = extractCookie(settings.cookie, "buvid3") || createFallbackBuvid();
  const config = await fetchDanmakuServerConfig(realRoomId, cookie);
  return {
    realRoomId,
    uid,
    buvid,
    token: config.token,
    hosts: config.hosts.length ? config.hosts : [DEFAULT_HOST],
  };
}

async function fetchRealRoomId(roomId: number, cookie: string): Promise<number> {
  const url = new URL(ROOM_INFO_URL);
  url.searchParams.set("room_id", String(roomId));
  const data = await fetchJson(url, cookie);
  const realRoomId = Number(readPath(data, ["data", "room_id"]));
  if (!Number.isFinite(realRoomId) || realRoomId <= 0) {
    throw new Error("Bilibili live room info response did not include room_id.");
  }
  return realRoomId;
}

async function fetchDanmakuServerConfig(
  roomId: number,
  cookie: string,
): Promise<DanmakuServerConfig> {
  const config = await tryFetchDanmakuServerConfig(roomId, cookie, true)
    ?? await tryFetchDanmakuServerConfig(roomId, cookie, false);
  if (!config) {
    if (!cookie) {
      throw new Error("B 站弹幕服务器配置获取失败：当前接口需要登录 Cookie 才能完成 WBI 签名。");
    }
    return { token: "", hosts: [DEFAULT_HOST] };
  }
  return config;
}

async function tryFetchDanmakuServerConfig(
  roomId: number,
  cookie: string,
  signed: boolean,
): Promise<DanmakuServerConfig | null> {
  try {
    const url = new URL(DANMAKU_INFO_URL);
    const baseParams = {
      id: String(roomId),
      type: "0",
      ...DANMAKU_WBI_DEVICE_PARAMS,
    };
    const params = signed
      ? await signWbiParams(baseParams, cookie)
      : baseParams;
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const data = await fetchJson(url, cookie);
    return parseDanmakuServerConfig(data);
  } catch (error) {
    console.warn(
      `[BilibiliLive] Danmaku server config request failed signed=${signed}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function parseDanmakuServerConfig(data: unknown): DanmakuServerConfig {
  const token = String(readPath(data, ["data", "token"]) ?? "");
  const hostList = readPath(data, ["data", "host_list"]);
  const hosts = Array.isArray(hostList)
    ? hostList.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const record = item as Record<string, unknown>;
      const host = typeof record.host === "string" ? record.host.trim() : "";
      const wssPort = Number(record.wss_port);
      return host && Number.isFinite(wssPort) && wssPort > 0
        ? [{ host, wssPort }]
        : [];
    })
    : [];
  return { token, hosts };
}

async function fetchJson(url: URL, cookie = ""): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": BILIBILI_WEB_USER_AGENT,
      Referer: "https://live.bilibili.com/",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Bilibili live request failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as unknown;
  const code = Number(readPath(data, ["code"]));
  if (Number.isFinite(code) && code !== 0) {
    const message = String(readPath(data, ["message"]) ?? "unknown error");
    throw new Error(`Bilibili live API error: ${message}`);
  }
  return data;
}

async function signWbiParams(
  params: Record<string, string>,
  cookie: string,
): Promise<Record<string, string>> {
  const wbiKey = await fetchWbiKey(cookie).catch((error: unknown) => {
    console.warn(
      "[BilibiliLive] WBI key request failed; retrying unsigned.",
      error instanceof Error ? error.message : error,
    );
    return "";
  });
  if (!wbiKey) {
    return params;
  }
  const wts = String(Math.floor(Date.now() / 1000));
  const paramsToSign = Object.fromEntries(
    Object.entries({ ...params, wts })
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, filterWbiValue(value)]),
  );
  const encoded = new URLSearchParams(paramsToSign).toString();
  const digest = await md5Hex(`${encoded}${wbiKey}`);
  return {
    ...paramsToSign,
    w_rid: digest,
  };
}

async function fetchWbiKey(cookie: string): Promise<string> {
  const data = await fetchJsonAllowingApiCodes(new URL(WBI_INIT_URL), cookie, [-101]);
  const imgUrl = String(readPath(data, ["data", "wbi_img", "img_url"]) ?? "");
  const subUrl = String(readPath(data, ["data", "wbi_img", "sub_url"]) ?? "");
  const imgKey = extractFilenameStem(imgUrl);
  const subKey = extractFilenameStem(subUrl);
  const combined = `${imgKey}${subKey}`;
  if (!combined) {
    return "";
  }
  return WBI_KEY_INDEX_TABLE
    .map((index) => combined[index] ?? "")
    .join("");
}

async function fetchJsonAllowingApiCodes(
  url: URL,
  cookie: string,
  allowedCodes: readonly number[],
): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": BILIBILI_WEB_USER_AGENT,
      Referer: "https://live.bilibili.com/",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Bilibili live request failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as unknown;
  const code = Number(readPath(data, ["code"]));
  if (Number.isFinite(code) && code !== 0 && !allowedCodes.includes(code)) {
    const message = String(readPath(data, ["message"]) ?? "unknown error");
    throw new Error(`Bilibili live API error: ${message}`);
  }
  return data;
}

function extractFilenameStem(url: string): string {
  const filename = url.split("/").pop() ?? "";
  return filename.split(".")[0] ?? "";
}

function filterWbiValue(value: string): string {
  return value.replace(/[!'()*]/g, "");
}

function normalizeCookie(cookie: string): string {
  return cookie.trim();
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
