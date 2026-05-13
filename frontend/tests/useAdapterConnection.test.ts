// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { effectScope } from "vue";
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

class FakeAudioTrack {
  stopped = false;
  addEventListener(_type: string, _listener: () => void, _options?: unknown): void {}
  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream {
  readonly audioTracks = [new FakeAudioTrack()];

  getAudioTracks(): FakeAudioTrack[] {
    return this.audioTracks;
  }

  getTracks(): FakeAudioTrack[] {
    return this.audioTracks;
  }
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];

  readonly port = {
    onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null,
    onmessageerror: null as ((event: Event) => void) | null,
    close() {},
  };

  constructor() {
    FakeAudioWorkletNode.instances.push(this);
  }

  disconnect(): void {}
  connect(): void {}

  emitChunk(chunk: Float32Array): void {
    this.port.onmessage?.({ data: chunk } as MessageEvent<Float32Array>);
  }
}

function installWindowStubs(): void {
  const storage = new Map<string, string>();
  const nativeUrl = globalThis.URL;
  (window as unknown as {
    localStorage: {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
      removeItem: (key: string) => void;
      clear: () => void;
    };
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
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
  window.addEventListener = () => {};
  window.removeEventListener = () => {};
  window.ag99desktop = {
    getLocalAdapterHosts: () => ["127.0.0.1"],
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => new FakeMediaStream(),
        enumerateDevices: async () => [],
      },
    },
  });
  Object.assign(globalThis, {
    AudioWorkletNode: FakeAudioWorkletNode,
  });
  window.AudioContext = class {
    state = "running";
    sampleRate = 16000;
    audioWorklet = {
      addModule: async () => {},
    };
    destination = {};
    async resume(): Promise<void> {}
    createMediaStreamSource() {
      return {
        connect() {},
        disconnect() {},
      };
    }
    createGain() {
      return {
        gain: { value: 0 },
        connect() {},
        disconnect() {},
      };
    }
    async close(): Promise<void> {}
  } as unknown as typeof AudioContext;
  Object.assign(globalThis, {
    Blob: class {},
  });
  Object.assign(nativeUrl, {
    createObjectURL: () => "blob:test",
    revokeObjectURL: () => {},
  });
}

function installWebSocketStub(): void {
  Object.assign(globalThis, {
    WebSocket: FakeWebSocket,
  });
}

function createConnectedAdapter() {
  FakeWebSocket.instances.length = 0;
  FakeAudioWorkletNode.instances.length = 0;
  const sessionStore = useTurnPlaybackSessionStore();
  const scope = effectScope();
  const adapter = scope.run(() => useAdapterConnection(sessionStore));
  if (!adapter) {
    throw new Error("expected adapter instance");
  }
  adapter.connect();
  const socket = FakeWebSocket.instances[0];
  if (!socket) {
    throw new Error("expected fake websocket instance");
  }
  socket.emitOpen();
  return { adapter, socket, sessionStore, scope };
}

function withConnectedAdapter(
  fn: (harness: {
    adapter: ReturnType<typeof useAdapterConnection>;
    socket: FakeWebSocket;
    sessionStore: ReturnType<typeof useTurnPlaybackSessionStore>;
  }) => void,
): void {
  const harness = createConnectedAdapter();
  try {
    fn(harness);
  } finally {
    harness.scope.stop();
  }
}

function lastHistoryText(adapter: ReturnType<typeof useAdapterConnection>): string {
  const entries = adapter.state.historyEntries;
  return entries[entries.length - 1]?.text ?? "";
}

function sendTurnStarted(socket: FakeWebSocket, turnId = "turn-1", orchestrationId = "orch-1"): void {
  socket.emitMessage(JSON.stringify({
    type: "control.turn_started",
    version: "v2",
    message_id: `start-${turnId}`,
    timestamp: "2026-05-08T00:00:00.000Z",
    session_id: "session-1",
    turn_id: turnId,
    orchestration_id: orchestrationId,
    source: "backend",
    payload: {},
  }));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function motionIntentEnvelope(messageId: string, turnId: string | null, orchestrationId: string | null) {
  return {
    type: "engine.motion_intent",
    version: "v2",
    message_id: messageId,
    timestamp: "2026-05-08T00:00:03.000Z",
    session_id: "session-1",
    turn_id: turnId,
    orchestration_id: orchestrationId,
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
  };
}

function testInvalidJsonMessage(): void {
  withConnectedAdapter(({ adapter, socket }) => {
    const initialHistoryLength = adapter.state.historyEntries.length;
    socket.emitMessage("{");
    assert.equal(adapter.state.lastError, "收到无法解析的后端消息。");
    assert.equal(adapter.state.statusMessage, "收到无法解析的后端消息。");
    assert.equal(adapter.state.historyEntries.length, initialHistoryLength + 1);
    assert.equal(lastHistoryText(adapter), "收到无法解析的后端消息。");
  });
}

function testVersionMismatchMessageDedupesHistory(): void {
  withConnectedAdapter(({ adapter, socket }) => {
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
  });
}

function testInvalidPayloadDoesNotEnterPlaybackState(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-invalid-payload", "orch-invalid-payload");
    const initialHistoryLength = adapter.state.historyEntries.length;
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "m-invalid-payload",
      timestamp: "2026-05-08T00:00:01.000Z",
      session_id: "session-invalid",
      turn_id: "turn-invalid-payload",
      orchestration_id: "orch-invalid-payload",
      source: "backend",
      payload: { text: 123 },
    }));

    assert.equal(
      adapter.state.lastError,
      "收到非法协议载荷（type=output.text, path=payload.text, expected=string）。",
    );
    assert.equal(adapter.state.pendingAssistantTexts.has("m-invalid-payload"), false);
    assert.equal(
      sessionStore.getSession("orch-invalid-payload")?.segments.has("m-invalid-payload"),
      false,
    );
    assert.equal(adapter.state.historyEntries.length, initialHistoryLength + 1);
  });
}

function testTextAudioMotionWithSameMessageIdShareSegment(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-segment", "orch-segment");
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "m-segment-1",
      timestamp: "2026-05-08T00:00:01.000Z",
      session_id: "session-segment",
      turn_id: "turn-segment",
      orchestration_id: "orch-segment",
      source: "backend",
      payload: { text: " segment text ", speaker_name: "assistant", avatar: "" },
    }));
    socket.emitMessage(JSON.stringify({
      type: "output.audio",
      version: "v2",
      message_id: "m-segment-1",
      timestamp: "2026-05-08T00:00:02.000Z",
      session_id: "session-segment",
      turn_id: "turn-segment",
      orchestration_id: "orch-segment",
      source: "backend",
      payload: {
        text: " audio fallback should not overwrite ",
        audio_url: "http://localhost/segment.wav",
        speaker_name: "assistant",
        avatar: "",
      },
    }));
    socket.emitMessage(JSON.stringify(motionIntentEnvelope("m-segment-1", "turn-segment", "orch-segment")));

    assert.equal(adapter.state.pendingAssistantTexts.get("m-segment-1")?.text, "segment text");
    assert.equal(
      adapter.state.pendingAudios.get("m-segment-1")?.audioUrl,
      "http://127.0.0.1/segment.wav",
    );

    const session = sessionStore.getSession("orch-segment");
    assert.ok(session);
    assert.equal(session?.segments.size, 1);
    assert.deepEqual(session?.segmentOrder, ["m-segment-1"]);
    const segment = session?.segments.get("m-segment-1");
    assert.equal(segment?.text.content, "segment text");
    assert.equal(segment?.audio.url, "http://127.0.0.1/segment.wav");
    assert.equal(segment?.motion.payload?.kind, "semantic_intent");
  });
}

function testMultipleMessageIdsDoNotOverwritePendingItems(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-multi", "orch-multi");
    for (const [messageId, text] of [["m-a", "First"], ["m-b", "Second"]] as const) {
      socket.emitMessage(JSON.stringify({
        type: "output.text",
        version: "v2",
        message_id: messageId,
        timestamp: "2026-05-08T00:00:01.000Z",
        session_id: "session-multi",
        turn_id: "turn-multi",
        orchestration_id: "orch-multi",
        source: "backend",
        payload: { text, speaker_name: "assistant", avatar: "" },
      }));
    }

    assert.equal(adapter.state.pendingAssistantTexts.get("m-a")?.text, "First");
    assert.equal(adapter.state.pendingAssistantTexts.get("m-b")?.text, "Second");
    assert.deepEqual(sessionStore.getSession("orch-multi")?.segmentOrder, ["m-a", "m-b"]);
  });
}

function testFallbackIdentityWritesCurrentSessionSegment(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-fallback", "orch-fallback");
    socket.emitMessage(JSON.stringify({
      type: "output.audio",
      version: "v2",
      message_id: "m-audio-fallback",
      timestamp: "2026-05-08T00:00:01.000Z",
      session_id: "session-fallback",
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

    assert.equal(adapter.state.pendingAudios.get("m-audio-fallback")?.turnId, "turn-fallback");
    assert.equal(adapter.state.pendingAudios.get("m-audio-fallback")?.orchestrationId, "orch-fallback");
    const segment = sessionStore.getSession("orch-fallback")?.segments.get("m-audio-fallback");
    assert.equal(segment?.audio.url, "http://127.0.0.1/audio-fallback.wav");
    assert.equal(segment?.text.content, "audio text");
  });
}

function testTurnStartedResetsPendingMaps(): void {
  withConnectedAdapter(({ adapter, socket }) => {
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "m-old",
      timestamp: "2026-05-08T00:00:00.000Z",
      session_id: "session-old",
      turn_id: "turn-old",
      orchestration_id: "orch-old",
      source: "backend",
      payload: { text: "queued", speaker_name: "assistant", avatar: "" },
    }));
    sendTurnStarted(socket, "turn-new", "orch-new");
    assert.equal(adapter.state.currentTurnId, "turn-new");
    assert.equal(adapter.state.currentOrchestrationId, "orch-new");
    assert.equal(adapter.state.pendingAssistantTexts.size, 0);
    assert.equal(adapter.state.pendingAudios.size, 0);
  });
}

function testSynthFinishedMarksMissingSegmentAudioAbsent(): void {
  withConnectedAdapter(({ socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-synth-finished", "orch-synth-finished");
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "m-no-audio",
      timestamp: "2026-05-08T00:00:01.000Z",
      session_id: "session-synth-finished",
      turn_id: "turn-synth-finished",
      orchestration_id: "orch-synth-finished",
      source: "backend",
      payload: { text: "no audio", speaker_name: "assistant", avatar: "" },
    }));
    socket.emitMessage(JSON.stringify({
      type: "control.synth_finished",
      version: "v2",
      message_id: "m-synth-finished",
      timestamp: "2026-05-08T00:00:02.000Z",
      session_id: "session-synth-finished",
      turn_id: null,
      orchestration_id: null,
      source: "backend",
      payload: {},
    }));

    const session = sessionStore.getSession("orch-synth-finished");
    assert.equal(session?.backend.synthFinished, true);
    assert.equal(session?.backend.turnFinished, false);
    assert.equal(session?.segments.get("m-no-audio")?.audio.terminal, "absent");
  });
}

function testSynthFinishedDoesNotMarkReleasedAudioAbsent(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-released-audio", "orch-released-audio");
    sessionStore.markAudioReceived(
      "orch-released-audio",
      "turn-released-audio",
      "http://localhost/audio.wav",
      "m-released-audio",
    );
    sessionStore.markAudioStarted(
      "orch-released-audio",
      "turn-released-audio",
      "m-released-audio",
      100,
      1000,
    );
    assert.equal(adapter.state.pendingAudios.size, 0);

    socket.emitMessage(JSON.stringify({
      type: "control.synth_finished",
      version: "v2",
      message_id: "m-synth-finished-released-audio",
      timestamp: "2026-05-08T00:00:02.000Z",
      session_id: "session-released-audio",
      turn_id: "turn-released-audio",
      orchestration_id: "orch-released-audio",
      source: "backend",
      payload: {},
    }));

    const session = sessionStore.getSession("orch-released-audio");
    const segment = session?.segments.get("m-released-audio");
    assert.equal(segment?.audio.released, true);
    assert.notEqual(segment?.audio.terminal, "absent");
  });
}

function testTurnFinishedDoesNotMarkMissingSegmentAudioAbsent(): void {
  withConnectedAdapter(({ socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-finished", "orch-finished");
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "m-no-audio-turn-finished",
      timestamp: "2026-05-08T00:00:01.000Z",
      session_id: "session-finished",
      turn_id: "turn-finished",
      orchestration_id: "orch-finished",
      source: "backend",
      payload: { text: "no audio", speaker_name: "assistant", avatar: "" },
    }));
    socket.emitMessage(JSON.stringify({
      type: "control.turn_finished",
      version: "v2",
      message_id: "m-turn-finished",
      timestamp: "2026-05-08T00:00:02.000Z",
      session_id: "session-finished",
      turn_id: null,
      orchestration_id: null,
      source: "backend",
      payload: { success: true },
    }));

    const session = sessionStore.getSession("orch-finished");
    assert.equal(session?.backend.turnFinished, true);
    assert.equal(
      session?.segments.get("m-no-audio-turn-finished")?.audio.terminal,
      "idle",
    );
  });
}

function testMotionFallbackDoesNotCreateAnonymousSession(): void {
  withConnectedAdapter(({ socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-motion", "orch-motion");
    socket.emitMessage(JSON.stringify(motionIntentEnvelope("m-motion", null, null)));

    const session = sessionStore.getSession("orch-motion");
    assert.ok(session);
    assert.equal(session?.segments.get("m-motion")?.motion.payload?.kind, "semantic_intent");
    assert.equal(sessionStore.getSessions().some((item) => item.id.startsWith("ephemeral:")), false);
  });
}

function testInvalidMotionDoesNotRewritePreviousSegment(): void {
  withConnectedAdapter(({ socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-motion-old", "orch-motion-old");
    socket.emitMessage(JSON.stringify(motionIntentEnvelope("m-motion-valid", null, null)));

    const beforeSessionCount = sessionStore.getSessions().length;
    const previousPayload =
      sessionStore.getSession("orch-motion-old")?.segments.get("m-motion-valid")?.motion.payload;

    socket.emitMessage(JSON.stringify({
      type: "engine.motion_intent",
      version: "v2",
      message_id: "m-motion-invalid",
      timestamp: "2026-05-08T00:00:04.000Z",
      session_id: "session-1",
      turn_id: null,
      orchestration_id: null,
      source: "backend",
      payload: {
        mode: "preview",
        intent: { schema_version: "engine.motion_intent.v1" },
      },
    }));

    assert.deepEqual(
      sessionStore.getSession("orch-motion-old")?.segments.get("m-motion-valid")?.motion.payload,
      previousPayload,
    );
    assert.equal(sessionStore.getSessions().length, beforeSessionCount);
  });
}

function testBackToBackTurnsDoNotSharePendingState(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    // Turn A
    sendTurnStarted(socket, "turn-a", "orch-a");
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "m-a",
      timestamp: "2026-05-08T00:00:01.000Z",
      session_id: "session-1",
      turn_id: "turn-a",
      orchestration_id: "orch-a",
      source: "backend",
      payload: { text: "text a", speaker_name: "assistant", avatar: "" },
    }));

    assert.ok(adapter.state.pendingAssistantTexts.has("m-a"));

    // Turn B starts, should clear Turn A's pending state
    sendTurnStarted(socket, "turn-b", "orch-b");
    assert.equal(adapter.state.currentTurnId, "turn-b");
    assert.equal(adapter.state.currentOrchestrationId, "orch-b");
    assert.equal(adapter.state.pendingAssistantTexts.size, 0);
    assert.equal(adapter.state.pendingAudios.size, 0);

    // Turn A's session should still exist for diagnostics
    assert.ok(sessionStore.getSession("orch-a"));
  });
}

function testStaleTurnFinishedDoesNotMarkCurrentTurnCompleted(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-current", "orch-current");

    // Send turn_finished for a DIFFERENT turn_id
    socket.emitMessage(JSON.stringify({
      type: "control.turn_finished",
      version: "v2",
      message_id: "m-stale",
      timestamp: "2026-05-08T00:00:02.000Z",
      session_id: "session-1",
      turn_id: "turn-other",
      orchestration_id: "orch-other",
      source: "backend",
      payload: { success: true },
    }));

    // Current turn should NOT be marked as finished
    const session = sessionStore.getSession("orch-current");
    assert.ok(session);
    // The stale turn_finished created a separate session, not affecting current
    assert.equal(session.backend.turnFinished, false);
  });
}

async function testAutoStartMicDoesNotDuplicateCaptureStart(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket } = harness;
    socket.emitMessage(JSON.stringify({
      type: "system.server_info",
      version: "v2",
      message_id: "server-info-1",
      timestamp: "2026-05-08T00:00:00.000Z",
      session_id: "session-1",
      turn_id: null,
      orchestration_id: null,
      source: "adapter",
      payload: {
        ws_url: "ws://127.0.0.1:12396",
        http_base_url: "http://127.0.0.1:12397",
        auto_start_mic: true,
      },
    }));
    socket.emitMessage(JSON.stringify({
      type: "control.start_mic",
      version: "v2",
      message_id: "start-mic-1",
      timestamp: "2026-05-08T00:00:00.001Z",
      session_id: "session-1",
      turn_id: null,
      orchestration_id: null,
      source: "adapter",
      payload: {},
    }));

    await flushMicrotasks();

    assert.equal(adapter.state.micCapturing, true);
    const openMicLogs = adapter.state.historyEntries.filter((entry) =>
      entry.text === "麦克风已开启，正在自动检测说话。"
    );
    assert.equal(openMicLogs.length, 1);
  } finally {
    harness.scope.stop();
  }
}

async function testMicAudioUsesFreshInputOrchestrationAcrossChunkAndEnd(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket } = harness;
    sendTurnStarted(socket, "turn-playback", "orch-playback-old");

    const started = await adapter.toggleMicrophoneCapture();
    assert.equal(started, true);
    const worklet = FakeAudioWorkletNode.instances[0];
    assert.ok(worklet);

    socket.sent.length = 0;
    worklet.emitChunk(new Float32Array([0.2, -0.1, 0.05]));
    await flushMicrotasks();
    await adapter.toggleMicrophoneCapture();

    const rawAudioMessage = socket.sent
      .map((item) => JSON.parse(item) as Record<string, unknown>)
      .find((item) => item.type === "input.raw_audio_data");
    const micEndMessage = socket.sent
      .map((item) => JSON.parse(item) as Record<string, unknown>)
      .find((item) => item.type === "input.mic_audio_end");

    assert.ok(rawAudioMessage);
    assert.ok(micEndMessage);
    assert.equal(typeof rawAudioMessage?.orchestration_id, "string");
    assert.equal(rawAudioMessage?.orchestration_id, micEndMessage?.orchestration_id);
    assert.notEqual(rawAudioMessage?.orchestration_id, "orch-playback-old");
    assert.match(String(rawAudioMessage?.orchestration_id), /^input:/);
    assert.deepEqual(micEndMessage?.payload, {
      reason: "manual_stop",
      dropped: false,
    });
  } finally {
    harness.scope.stop();
  }
}

async function testMicAudioDropMarksBrokenSequenceAndReportsDroppedEnd(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket } = harness;
    const started = await adapter.toggleMicrophoneCapture();
    assert.equal(started, true);
    const worklet = FakeAudioWorkletNode.instances[0];
    assert.ok(worklet);

    socket.sent.length = 0;
    socket.bufferedAmount = 600 * 1024;
    worklet.emitChunk(new Float32Array([0.3, 0.1, -0.2]));
    await flushMicrotasks();

    assert.equal(adapter.state.lastError, "麦克风音频发送积压，本段收音已丢弃。");
    assert.equal(adapter.state.statusMessage, "麦克风音频发送积压，本段收音已丢弃。");
    assert.equal(
      adapter.state.historyEntries.some((entry) => entry.text === "麦克风音频发送积压，本段收音已丢弃。"),
      true,
    );
    assert.equal(
      socket.sent.some((item) => item.includes("\"input.raw_audio_data\"")),
      false,
    );

    socket.bufferedAmount = 0;
    await adapter.toggleMicrophoneCapture();

    const micEndMessage = socket.sent
      .map((item) => JSON.parse(item) as Record<string, unknown>)
      .find((item) => item.type === "input.mic_audio_end");
    assert.ok(micEndMessage);
    assert.deepEqual(micEndMessage?.payload, {
      reason: "manual_stop",
      dropped: true,
    });
  } finally {
    harness.scope.stop();
  }
}

async function run(): Promise<void> {
  installWindowStubs();
  installWebSocketStub();

  testInvalidJsonMessage();
  testVersionMismatchMessageDedupesHistory();
  testInvalidPayloadDoesNotEnterPlaybackState();
  testTextAudioMotionWithSameMessageIdShareSegment();
  testMultipleMessageIdsDoNotOverwritePendingItems();
  testFallbackIdentityWritesCurrentSessionSegment();
  testTurnStartedResetsPendingMaps();
  testSynthFinishedMarksMissingSegmentAudioAbsent();
  testSynthFinishedDoesNotMarkReleasedAudioAbsent();
  testTurnFinishedDoesNotMarkMissingSegmentAudioAbsent();
  testMotionFallbackDoesNotCreateAnonymousSession();
  testInvalidMotionDoesNotRewritePreviousSegment();
  testBackToBackTurnsDoNotSharePendingState();
  testStaleTurnFinishedDoesNotMarkCurrentTurnCompleted();
  await testAutoStartMicDoesNotDuplicateCaptureStart();
  await testMicAudioUsesFreshInputOrchestrationAcrossChunkAndEnd();
  await testMicAudioDropMarksBrokenSequenceAndReportsDroppedEnd();

  console.log("useAdapterConnection tests passed");
}

void run();
