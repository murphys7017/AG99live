import assert from "node:assert/strict";
import {
  BILIBILI_PACKET_TEST_ONLY,
  extractDanmakuMessage,
  makeBilibiliAuthPacket,
  parseBilibiliCommands,
} from "../src/bilibili-live/bilibiliPacket.js";
import {
  BILIBILI_LIVE_CLIENT_TEST_ONLY,
} from "../src/bilibili-live/bilibiliLiveClient.js";
import {
  DEFAULT_BILIBILI_LIVE_SETTINGS,
} from "../src/types/bilibili-live.js";
import {
  normalizeBilibiliLiveSettings,
} from "../src/bilibili-live/settings.js";
import {
  defaultSnapshot,
  normalizeSnapshot,
} from "../src/desktop-bridge/snapshot/runtimeSnapshot.js";

function makeServerPacket(payload: Record<string, unknown>): ArrayBuffer {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const headerSize = BILIBILI_PACKET_TEST_ONLY.HEADER_SIZE;
  const packet = new ArrayBuffer(headerSize + body.byteLength);
  const view = new DataView(packet);
  view.setUint32(0, headerSize + body.byteLength);
  view.setUint16(4, headerSize);
  view.setUint16(6, BILIBILI_PACKET_TEST_ONLY.PROTO_NORMAL);
  view.setUint32(8, BILIBILI_PACKET_TEST_ONLY.OP_SEND_MSG_REPLY);
  view.setUint32(12, 1);
  new Uint8Array(packet, headerSize).set(body);
  return packet;
}

async function testPacketParsesDanmakuCommand(): Promise<void> {
  const packet = makeServerPacket({
    cmd: "DANMU_MSG",
    info: [
      [],
      "你好呀",
      [123, "Aki"],
    ],
  });
  const commands = await parseBilibiliCommands(packet);
  assert.equal(commands.length, 1);
  const message = extractDanmakuMessage(commands[0]);
  assert.equal(message?.uid, 123);
  assert.equal(message?.uname, "Aki");
  assert.equal(message?.text, "你好呀");
}

function testAuthPacketIsBinary(): void {
  const packet = makeBilibiliAuthPacket({ uid: 0, roomid: 1 });
  const view = new DataView(packet);
  assert.equal(view.getUint16(4), BILIBILI_PACKET_TEST_ONLY.HEADER_SIZE);
  assert.equal(view.getUint32(8), 7);
}

function testCookieParsing(): void {
  const cookie = "SESSDATA=abc; DedeUserID=42; buvid3=BUVID_TEST";
  assert.equal(
    BILIBILI_LIVE_CLIENT_TEST_ONLY.extractNumericCookie(cookie, "DedeUserID"),
    42,
  );
  assert.equal(
    BILIBILI_LIVE_CLIENT_TEST_ONLY.extractCookie(cookie, "buvid3"),
    "BUVID_TEST",
  );
}

async function testMd5(): Promise<void> {
  assert.equal(
    await BILIBILI_LIVE_CLIENT_TEST_ONLY.md5Hex("abc"),
    "900150983cd24fb0d6963f7d28e17f72",
  );
}

function testAuthPayloadOmitsEmptyToken(): void {
  const payload = BILIBILI_LIVE_CLIENT_TEST_ONLY.buildAuthPayload({
    realRoomId: 123,
    uid: 0,
    buvid: "BUVID_TEST",
    token: "",
    hosts: [],
  });
  assert.equal(payload.roomid, 123);
  assert.equal(payload.buvid, "BUVID_TEST");
  assert.equal("key" in payload, false);
}

function testAuthPayloadIncludesToken(): void {
  const payload = BILIBILI_LIVE_CLIENT_TEST_ONLY.buildAuthPayload({
    realRoomId: 123,
    uid: 0,
    buvid: "BUVID_TEST",
    token: "token-test",
    hosts: [],
  });
  assert.equal(payload.key, "token-test");
}

function testPreferredProtoverFallsBackWhenBrotliUnsupported(): void {
  const original = globalThis.DecompressionStream;
  try {
    Object.assign(globalThis, {
      DecompressionStream: class {
        constructor(format: string) {
          if (format === "br") {
            throw new Error("unsupported br");
          }
        }
      },
    });
    assert.equal(BILIBILI_LIVE_CLIENT_TEST_ONLY.resolvePreferredProtover(), 2);
  } finally {
    Object.assign(globalThis, { DecompressionStream: original });
  }
}

function testPreferredProtoverUsesBrotliWhenSupported(): void {
  const original = globalThis.DecompressionStream;
  try {
    Object.assign(globalThis, {
      DecompressionStream: class {
        constructor(_format: string) {}
      },
    });
    assert.equal(BILIBILI_LIVE_CLIENT_TEST_ONLY.resolvePreferredProtover(), 3);
  } finally {
    Object.assign(globalThis, { DecompressionStream: original });
  }
}

function testLastCommandNameUsesLatestCommand(): void {
  assert.equal(
    BILIBILI_LIVE_CLIENT_TEST_ONLY.getLastCommandName([
      { cmd: "INTERACT_WORD" },
      { cmd: "DANMU_MSG:4:0:2:2:2:0" },
    ]),
    "DANMU_MSG:4:0:2:2:2:0",
  );
}

function testSettingsNormalize(): void {
  assert.deepEqual(
    normalizeBilibiliLiveSettings({
      enabled: true,
      roomId: " 123 ",
      cookie: " SESSDATA=x ",
      responseIntervalSeconds: 1,
    }),
    {
      ...DEFAULT_BILIBILI_LIVE_SETTINGS,
      enabled: true,
      roomId: "123",
      cookie: "SESSDATA=x",
      responseIntervalSeconds: 5,
    },
  );
}

function testSnapshotNormalize(): void {
  const normalized = normalizeSnapshot({
    ...defaultSnapshot,
    bilibiliLiveStatus: {
      enabled: true,
      connected: true,
      status: "connected",
      roomId: "123",
      realRoomId: 456,
      bufferedCount: 7.2,
      authReceived: true,
      heartbeatReceived: true,
      commandCount: 3.8,
      danmakuCount: 2.2,
      lastCommand: "DANMU_MSG",
      protover: 2.4,
      lastMessageAt: "2026-06-09T00:00:00.000Z",
      lastError: "",
      hasCookie: true,
    },
  });
  assert.equal(normalized.bilibiliLiveStatus.connected, true);
  assert.equal(normalized.bilibiliLiveStatus.bufferedCount, 7);
  assert.equal(normalized.bilibiliLiveStatus.authReceived, true);
  assert.equal(normalized.bilibiliLiveStatus.heartbeatReceived, true);
  assert.equal(normalized.bilibiliLiveStatus.commandCount, 4);
  assert.equal(normalized.bilibiliLiveStatus.danmakuCount, 2);
  assert.equal(normalized.bilibiliLiveStatus.lastCommand, "DANMU_MSG");
  assert.equal(normalized.bilibiliLiveStatus.protover, 2);
}

await testPacketParsesDanmakuCommand();
testAuthPacketIsBinary();
testCookieParsing();
await testMd5();
testAuthPayloadOmitsEmptyToken();
testAuthPayloadIncludesToken();
testPreferredProtoverFallsBackWhenBrotliUnsupported();
testPreferredProtoverUsesBrotliWhenSupported();
testLastCommandNameUsesLatestCommand();
testSettingsNormalize();
testSnapshotNormalize();

console.info("bilibiliLive tests passed.");

