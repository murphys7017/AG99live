// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { useAdapterConnection } from "../src/composables/useAdapterConnection.js";

interface ListenerMap {
  open?: Array<() => void>;
  message?: Array<(event: { data: string }) => void>;
  error?: Array<() => void>;
  close?: Array<() => void>;
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly listeners: ListenerMap = {};
  readyState = FakeWebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: "open" | "message" | "error" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: string }) => void): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (() => void) | ((event: { data: string }) => void),
  ): void {
    const bucket = (this.listeners[type] ??= []);
    bucket.push(listener as never);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitOpen(): void {
    for (const listener of this.listeners.open ?? []) {
      listener();
    }
  }

  emitMessage(data: string): void {
    for (const listener of this.listeners.message ?? []) {
      listener({ data });
    }
  }
}

function installWindowStubs(): void {
  const storage = new Map<string, string>();
  (window as unknown as {
    localStorage: {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
      removeItem: (key: string) => void;
      clear: () => void;
    };
    ag99desktop?: { getLocalAdapterHosts?: () => string[] };
  }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
  };
  window.ag99desktop = {
    getLocalAdapterHosts: () => ["127.0.0.1"],
  };
}

function installWebSocketStub(): void {
  Object.assign(globalThis, {
    WebSocket: FakeWebSocket,
  });
}

function lastHistoryText(adapter: ReturnType<typeof useAdapterConnection>): string {
  const entries = adapter.state.historyEntries;
  return entries[entries.length - 1]?.text ?? "";
}

function createConnectedAdapter() {
  FakeWebSocket.instances.length = 0;
  const adapter = useAdapterConnection();
  adapter.connect();
  const socket = FakeWebSocket.instances[0];
  if (!socket) {
    throw new Error("expected fake websocket instance");
  }
  socket.emitOpen();
  return { adapter, socket };
}

function testInvalidJsonMessage(): void {
  const { adapter, socket } = createConnectedAdapter();
  const initialHistoryLength = adapter.state.historyEntries.length;
  socket.emitMessage("{");
  assert.equal(adapter.state.lastError, "收到无法解析的后端消息。");
  assert.equal(adapter.state.statusMessage, "收到无法解析的后端消息。");
  assert.equal(adapter.state.historyEntries.length, initialHistoryLength + 1);
  assert.equal(lastHistoryText(adapter), "收到无法解析的后端消息。");
}

function testVersionMismatchMessageDedupesHistory(): void {
  const { adapter, socket } = createConnectedAdapter();
  const payload = JSON.stringify({
    type: "output.text",
    version: "wrong",
    message_id: "m-1",
    timestamp: "2026-05-08T00:00:00.000Z",
    session_id: "session-1",
    turn_id: "turn-1",
    source: "backend",
    payload: { text: "hello", speaker_name: "", avatar: "" },
  });
  const initialHistoryLength = adapter.state.historyEntries.length;
  socket.emitMessage(payload);
  socket.emitMessage(payload);
  assert.equal(
    adapter.state.lastError,
    "收到协议版本不匹配的消息（expected=v2, actual=wrong）。",
  );
  assert.equal(adapter.state.historyEntries.length, initialHistoryLength + 1);
  assert.equal(lastHistoryText(adapter), "收到协议版本不匹配的消息（expected=v2, actual=wrong）。");
}

function testOutputTextMessageQueuesPendingText(): void {
  const { adapter, socket } = createConnectedAdapter();
  socket.emitMessage(JSON.stringify({
    type: "output.text",
    version: "v2",
    message_id: "m-2",
    timestamp: "2026-05-08T00:00:00.000Z",
    session_id: "session-2",
    turn_id: "turn-2",
    orchestration_id: "orch-2",
    source: "backend",
    payload: {
      text: " hello ",
      speaker_name: "assistant",
      avatar: "",
    },
  }));
  assert.equal(adapter.state.pendingAssistantText, "hello");
  assert.equal(adapter.state.pendingAssistantTextTurnId, "turn-2");
  assert.equal(adapter.state.pendingAssistantTextOrchestrationId, "orch-2");
  assert.equal(adapter.state.statusMessage, "已收到文本回复，等待同步播放。");
}

function testTurnStartedResetsPendingState(): void {
  const { adapter, socket } = createConnectedAdapter();
  socket.emitMessage(JSON.stringify({
    type: "output.text",
    version: "v2",
    message_id: "m-3",
    timestamp: "2026-05-08T00:00:00.000Z",
    session_id: "session-3",
    turn_id: "turn-3",
    orchestration_id: "orch-3",
    source: "backend",
    payload: {
      text: "queued",
      speaker_name: "assistant",
      avatar: "",
    },
  }));
  socket.emitMessage(JSON.stringify({
    type: "control.turn_started",
    version: "v2",
    message_id: "m-4",
    timestamp: "2026-05-08T00:00:01.000Z",
    session_id: "session-3",
    turn_id: "turn-4",
    orchestration_id: "orch-4",
    source: "backend",
    payload: {},
  }));
  assert.equal(adapter.state.currentTurnId, "turn-4");
  assert.equal(adapter.state.currentOrchestrationId, "orch-4");
  assert.equal(adapter.state.pendingAssistantText, "");
  assert.equal(adapter.state.pendingAudioUrl, "");
  assert.equal(adapter.state.statusMessage, "后端正在处理这一轮对话。");
}

function run(): void {
  installWindowStubs();
  installWebSocketStub();

  testInvalidJsonMessage();
  testVersionMismatchMessageDedupesHistory();
  testOutputTextMessageQueuesPendingText();
  testTurnStartedResetsPendingState();

  console.log("useAdapterConnection tests passed");
}

run();
