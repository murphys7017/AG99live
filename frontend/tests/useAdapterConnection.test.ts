// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { useAdapterConnection } from "../src/composables/useAdapterConnection.js";
import { useTurnPlaybackSessionStore } from "../src/composables/useTurnPlaybackSessionStore.js";

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
  const sessionStore = useTurnPlaybackSessionStore();
  const adapter = useAdapterConnection(sessionStore);
  adapter.connect();
  const socket = FakeWebSocket.instances[0];
  if (!socket) {
    throw new Error("expected fake websocket instance");
  }
  socket.emitOpen();
  return { adapter, socket, sessionStore };
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

function testOutputTextFallsBackToCurrentSessionIdentity(): void {
  const { adapter, socket, sessionStore } = createConnectedAdapter();
  socket.emitMessage(JSON.stringify({
    type: "control.turn_started",
    version: "v2",
    message_id: "m-turn-start-text",
    timestamp: "2026-05-08T00:00:00.000Z",
    session_id: "session-text-fallback",
    turn_id: "turn-text-fallback",
    orchestration_id: "orch-text-fallback",
    source: "backend",
    payload: {},
  }));
  socket.emitMessage(JSON.stringify({
    type: "output.text",
    version: "v2",
    message_id: "m-text-fallback",
    timestamp: "2026-05-08T00:00:01.000Z",
    session_id: "session-text-fallback",
    turn_id: "turn-text-fallback",
    source: "backend",
    payload: {
      text: " fallback text ",
      speaker_name: "assistant",
      avatar: "",
    },
  }));

  assert.equal(adapter.state.pendingAssistantText, "fallback text");
  assert.equal(adapter.state.pendingAssistantTextTurnId, "turn-text-fallback");
  assert.equal(adapter.state.pendingAssistantTextOrchestrationId, "orch-text-fallback");
  const session = sessionStore.getSession("orch-text-fallback");
  assert.ok(session);
  assert.equal(session?.text.content, "fallback text");
}

function testOutputAudioFallsBackToCurrentSessionIdentity(): void {
  const { adapter, socket, sessionStore } = createConnectedAdapter();
  socket.emitMessage(JSON.stringify({
    type: "control.turn_started",
    version: "v2",
    message_id: "m-turn-start-audio",
    timestamp: "2026-05-08T00:00:00.000Z",
    session_id: "session-audio-fallback",
    turn_id: "turn-audio-fallback",
    orchestration_id: "orch-audio-fallback",
    source: "backend",
    payload: {},
  }));
  socket.emitMessage(JSON.stringify({
    type: "output.audio",
    version: "v2",
    message_id: "m-audio-fallback",
    timestamp: "2026-05-08T00:00:01.000Z",
    session_id: "session-audio-fallback",
    turn_id: null,
    orchestration_id: null,
    source: "backend",
    payload: {
      text: " audio text ",
      audio_url: "http://localhost/audio-fallback.wav",
      speaker_name: "assistant",
      avatar: "",
    },
  }));

  assert.equal(adapter.state.pendingAudioUrl, "http://127.0.0.1/audio-fallback.wav");
  assert.equal(adapter.state.pendingAudioTurnId, "turn-audio-fallback");
  assert.equal(adapter.state.pendingAudioOrchestrationId, "orch-audio-fallback");
  const session = sessionStore.getSession("orch-audio-fallback");
  assert.ok(session);
  assert.equal(session?.audio.url, "http://127.0.0.1/audio-fallback.wav");
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

function testTurnFinishedFallbackMarksAbsentAudio(): void {
  const { adapter, socket, sessionStore } = createConnectedAdapter();
  socket.emitMessage(JSON.stringify({
    type: "control.turn_started",
    version: "v2",
    message_id: "m-turn-start-finished",
    timestamp: "2026-05-08T00:00:00.000Z",
    session_id: "session-turn-finished",
    turn_id: "turn-finished",
    orchestration_id: "orch-finished",
    source: "backend",
    payload: {},
  }));
  socket.emitMessage(JSON.stringify({
    type: "control.turn_finished",
    version: "v2",
    message_id: "m-turn-finished",
    timestamp: "2026-05-08T00:00:01.000Z",
    session_id: "session-turn-finished",
    turn_id: null,
    orchestration_id: null,
    source: "backend",
    payload: {
      success: true,
    },
  }));

  const session = sessionStore.getSession("orch-finished");
  assert.ok(session);
  assert.equal(session?.backend.turnFinished, true);
  assert.equal(session?.audio.terminal, "absent");
}

function testMotionIntentFallsBackToCurrentSessionWithoutAnonymousSession(): void {
  const { socket, sessionStore } = createConnectedAdapter();
  socket.emitMessage(JSON.stringify({
    type: "control.turn_started",
    version: "v2",
    message_id: "m-turn-start-motion",
    timestamp: "2026-05-08T00:00:00.000Z",
    session_id: "session-motion",
    turn_id: "turn-motion",
    orchestration_id: "orch-motion",
    source: "backend",
    payload: {},
  }));
  socket.emitMessage(JSON.stringify({
    type: "engine.motion_intent",
    version: "v2",
    message_id: "m-motion-valid",
    timestamp: "2026-05-08T00:00:01.000Z",
    session_id: "session-motion",
    turn_id: null,
    orchestration_id: null,
    source: "backend",
    payload: {
      mode: "preview",
      intent: {
        schema_version: "engine.motion_intent.v2",
        profile_id: "profile-1",
        profile_revision: 1,
        model_id: "model-1",
        mode: "expressive",
        emotion_label: "happy",
        axes: {
          smile: { value: 0.8 },
        },
      },
    },
  }));

  const session = sessionStore.getSession("orch-motion");
  assert.ok(session);
  assert.equal(session?.motion.payload?.kind, "semantic_intent");
  assert.equal(
    sessionStore.getSessions().some((item) => item.id.startsWith("ephemeral:")),
    false,
  );
}

function testInvalidMotionDoesNotRewritePreviousSessionMotion(): void {
  const { socket, sessionStore } = createConnectedAdapter();
  socket.emitMessage(JSON.stringify({
    type: "control.turn_started",
    version: "v2",
    message_id: "m-turn-start-motion-old",
    timestamp: "2026-05-08T00:00:00.000Z",
    session_id: "session-motion-old",
    turn_id: "turn-motion-old",
    orchestration_id: "orch-motion-old",
    source: "backend",
    payload: {},
  }));
  socket.emitMessage(JSON.stringify({
    type: "engine.motion_intent",
    version: "v2",
    message_id: "m-motion-old-valid",
    timestamp: "2026-05-08T00:00:01.000Z",
    session_id: "session-motion-old",
    turn_id: null,
    orchestration_id: null,
    source: "backend",
    payload: {
      mode: "preview",
      intent: {
        schema_version: "engine.motion_intent.v2",
        profile_id: "profile-2",
        profile_revision: 2,
        model_id: "model-2",
        mode: "expressive",
        emotion_label: "calm",
        axes: {
          smile: { value: 0.2 },
        },
      },
    },
  }));

  const beforeSessionCount = sessionStore.getSessions().length;
  const previousPayload = sessionStore.getSession("orch-motion-old")?.motion.payload;

  socket.emitMessage(JSON.stringify({
    type: "engine.motion_intent",
    version: "v2",
    message_id: "m-motion-invalid",
    timestamp: "2026-05-08T00:00:02.000Z",
    session_id: "session-motion-old",
    turn_id: null,
    orchestration_id: null,
    source: "backend",
    payload: {
      mode: "preview",
      intent: {
        schema_version: "engine.motion_intent.v1",
      },
    },
  }));

  assert.deepEqual(sessionStore.getSession("orch-motion-old")?.motion.payload, previousPayload);
  assert.equal(sessionStore.getSessions().length, beforeSessionCount);
}

function run(): void {
  installWindowStubs();
  installWebSocketStub();

  testInvalidJsonMessage();
  testVersionMismatchMessageDedupesHistory();
  testOutputTextMessageQueuesPendingText();
  testOutputTextFallsBackToCurrentSessionIdentity();
  testOutputAudioFallsBackToCurrentSessionIdentity();
  testTurnStartedResetsPendingState();
  testTurnFinishedFallbackMarksAbsentAudio();
  testMotionIntentFallsBackToCurrentSessionWithoutAnonymousSession();
  testInvalidMotionDoesNotRewritePreviousSessionMotion();

  console.log("useAdapterConnection tests passed");
}

run();
