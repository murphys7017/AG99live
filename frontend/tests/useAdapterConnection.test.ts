// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { effectScope } from "vue";
import { useAdapterConnection } from "../src/adapter-connection/useAdapterConnection.js";
import { createModelSync } from "../src/adapter-connection/model-sync/useModelSync.js";
import { buildPendingPlaybackKey } from "../src/playback-timeline/playbackReleaseQueue.js";
import { useTurnPlaybackSessionStore } from "../src/turn-playback/useTurnPlaybackSessionStore.js";

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
  sent: Array<string | ArrayBuffer> = [];
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

  send(data: string | ArrayBuffer): void {
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

class FakeAudio {
  static instances: FakeAudio[] = [];
  static nextPlayShouldStall = false;

  currentTime = 0;
  duration = 1.25;
  private listeners = new Map<string, Array<() => void>>();

  constructor(_src: string) {
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  async play(): Promise<void> {
    if (FakeAudio.nextPlayShouldStall) {
      FakeAudio.nextPlayShouldStall = false;
      return new Promise<void>(() => {});
    }
    await Promise.resolve();
    this.emit("loadedmetadata");
    this.emit("playing");
  }

  pause(): void {}

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

function pendingKey(turnId: string | null, messageId: string): string {
  return buildPendingPlaybackKey(turnId, messageId);
}

let deferredGetUserMedia: {
  promise: Promise<FakeMediaStream>;
  resolve: () => void;
} | null = null;

function deferNextGetUserMedia(): void {
  let resolveDeferred!: () => void;
  const promise = new Promise<FakeMediaStream>((resolve) => {
    resolveDeferred = () => resolve(new FakeMediaStream());
  });
  deferredGetUserMedia = {
    promise,
    resolve: resolveDeferred,
  };
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
        getUserMedia: async () => {
          const deferred = deferredGetUserMedia;
          if (deferred) {
            return deferred.promise;
          }
          return new FakeMediaStream();
        },
        enumerateDevices: async () => [],
      },
    },
  });
  Object.assign(globalThis, {
    AudioWorkletNode: FakeAudioWorkletNode,
    Audio: FakeAudio,
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
  FakeAudio.instances.length = 0;
  FakeAudio.nextPlayShouldStall = false;
  deferredGetUserMedia = null;
  const sessionStore = useTurnPlaybackSessionStore();
  const modelSync = createModelSync();
  const scope = effectScope();
  const adapter = scope.run(() => useAdapterConnection(sessionStore, modelSync));
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

function sendTurnStarted(socket: FakeWebSocket, turnId = "turn-1"): void {
  socket.emitMessage(JSON.stringify({
    type: "control.turn_started",
    version: "v2",
    message_id: `start-${turnId}`,
    timestamp: "2026-05-08T00:00:00.000Z",
    turn_id: turnId,
    source: "backend",
    payload: {},
  }));
}

function sendSynthFinished(socket: FakeWebSocket, turnId: string | null, messageId: string): void {
  socket.emitMessage(JSON.stringify({
    type: "control.synth_finished",
    version: "v2",
    message_id: messageId,
    timestamp: "2026-05-08T00:00:02.000Z",
    turn_id: turnId,
    source: "backend",
    payload: {},
  }));
}

function sendOutputAudio(
  socket: FakeWebSocket,
  options: {
    turnId: string;
    messageId: string;
    audioUrl: string;
    captionText?: string;
  },
): void {
  socket.emitMessage(JSON.stringify({
    type: "output.audio",
    version: "v2",
    message_id: options.messageId,
    timestamp: "2026-05-08T00:00:03.000Z",
    turn_id: options.turnId,
    source: "backend",
    payload: {
      audio_url: options.audioUrl,
      caption_text: options.captionText ?? "hello",
      speaker_name: "Alice",
      avatar: "",
    },
  }));
}

function parseSentJsonMessages(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent
    .filter((item): item is string => typeof item === "string")
    .map((item) => JSON.parse(item) as Record<string, unknown>);
}

function sentBinaryFrames(socket: FakeWebSocket): Array<ArrayBuffer> {
  return socket.sent.filter((item): item is ArrayBuffer => item instanceof ArrayBuffer);
}

function parseAudioFrameMetadata(frame: ArrayBuffer): Record<string, unknown> {
  const view = new DataView(frame);
  const bytes = new Uint8Array(frame);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "AG99");
  assert.equal(view.getUint8(4), 1);
  assert.equal(view.getUint8(5), 1);
  const metadataLength = view.getUint32(8, true);
  const metadataBytes = bytes.slice(12, 12 + metadataLength);
  return JSON.parse(new TextDecoder().decode(metadataBytes)) as Record<string, unknown>;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function motionIntentEnvelope(messageId: string, turnId: string | null) {
  return {
    type: "engine.motion_intent",
    version: "v2",
    message_id: messageId,
    timestamp: "2026-05-08T00:00:03.000Z",
    turn_id: turnId,
    source: "backend",
    payload: {
      mode: "preview",
      intent: {
        schema_version: "engine.motion_intent.v3",
        profile_id: "profile-1",
        profile_revision: 1,
        model_id: "model-1",
        mode: "expressive",
        intent_tags: ["happy"],
        emotion_label: "happy",
        axes: {
          mouth_smile: 80,
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
    sendTurnStarted(socket, "turn-invalid-payload");
    const initialHistoryLength = adapter.state.historyEntries.length;
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "m-invalid-payload",
      timestamp: "2026-05-08T00:00:01.000Z",
      turn_id: "turn-invalid-payload",
      source: "backend",
      payload: { text: 123 },
    }));

    assert.equal(
      adapter.state.lastError,
      "收到非法协议载荷（type=output.text, path=payload.text, expected=string）。",
    );
    assert.equal(
      adapter.state.pendingAssistantTexts.has(pendingKey("turn-invalid-payload", "m-invalid-payload")),
      false,
    );
    assert.equal(
      sessionStore.getSession("turn-invalid-payload")?.segments.has("m-invalid-payload"),
      false,
    );
    assert.equal(adapter.state.historyEntries.length, initialHistoryLength + 1);
  });
}

function testTextAudioMotionWithSameMessageIdShareSegment(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-segment");
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "m-segment-1",
      timestamp: "2026-05-08T00:00:01.000Z",
      turn_id: "turn-segment",
      source: "backend",
      payload: { text: " segment text ", speaker_name: "assistant", avatar: "" },
    }));
    socket.emitMessage(JSON.stringify({
      type: "output.audio",
      version: "v2",
      message_id: "m-segment-1",
      timestamp: "2026-05-08T00:00:02.000Z",
      turn_id: "turn-segment",
      source: "backend",
      payload: {
        caption_text: " audio fallback should not overwrite ",
        audio_url: "http://localhost/segment.wav",
        speaker_name: "assistant",
        avatar: "",
      },
    }));
    socket.emitMessage(JSON.stringify(motionIntentEnvelope("m-segment-1", "turn-segment")));

    assert.equal(
      adapter.state.pendingAssistantTexts.get(pendingKey("turn-segment", "m-segment-1"))?.text,
      "segment text",
    );
    assert.equal(
      adapter.state.pendingAudios.get(pendingKey("turn-segment", "m-segment-1"))?.audioUrl,
      "http://127.0.0.1/segment.wav",
    );

    const session = sessionStore.getSession("turn-segment");
    assert.ok(session);
    assert.equal(session?.segments.size, 1);
    assert.deepEqual(session?.segmentOrder, ["m-segment-1"]);
    const segment = session?.segments.get("m-segment-1");
    assert.equal(segment?.text.content, "segment text");
    assert.equal(segment?.audio.url, "http://127.0.0.1/segment.wav");
    assert.equal(segment?.audio.captionText, "audio fallback should not overwrite");
    assert.equal(segment?.motion.payload?.kind, "semantic_intent");
  });
}

function testMultipleMessageIdsDoNotOverwritePendingItems(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-multi");
    for (const [messageId, text] of [["m-a", "First"], ["m-b", "Second"]] as const) {
      socket.emitMessage(JSON.stringify({
        type: "output.text",
        version: "v2",
        message_id: messageId,
        timestamp: "2026-05-08T00:00:01.000Z",
        turn_id: "turn-multi",
        source: "backend",
        payload: { text, speaker_name: "assistant", avatar: "" },
      }));
    }

    assert.equal(adapter.state.pendingAssistantTexts.get(pendingKey("turn-multi", "m-a"))?.text, "First");
    assert.equal(adapter.state.pendingAssistantTexts.get(pendingKey("turn-multi", "m-b"))?.text, "Second");
    assert.deepEqual(sessionStore.getSession("turn-multi")?.segmentOrder, ["m-a", "m-b"]);
  });
}

function testSameMessageIdAcrossTurnsDoesNotOverwritePendingItems(): void {
  withConnectedAdapter(({ adapter, socket }) => {
    for (const [turnId, text] of [["turn-a", "First"], ["turn-b", "Second"]] as const) {
      socket.emitMessage(JSON.stringify({
        type: "output.text",
        version: "v2",
        message_id: "shared-message",
        timestamp: "2026-05-08T00:00:01.000Z",
        turn_id: turnId,
        source: "backend",
        payload: { text, speaker_name: "assistant", avatar: "" },
      }));
    }

    assert.equal(
      adapter.state.pendingAssistantTexts.get(pendingKey("turn-a", "shared-message"))?.text,
      "First",
    );
    assert.equal(
      adapter.state.pendingAssistantTexts.get(pendingKey("turn-b", "shared-message"))?.text,
      "Second",
    );
  });
}

function testOutputAudioWithoutTurnIdIsRejected(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-missing-audio-turn");
    socket.emitMessage(JSON.stringify({
      type: "output.audio",
      version: "v2",
      message_id: "m-audio-missing-turn",
      timestamp: "2026-05-08T00:00:01.000Z",
      turn_id: null,
      source: "backend",
      payload: {
        caption_text: " audio text ",
        audio_url: "http://localhost/audio-fallback.wav",
        speaker_name: "assistant",
        avatar: "",
      },
    }));

    assert.match(adapter.state.lastError, /path=turn_id/);
    assert.equal(
      adapter.state.pendingAudios.has(pendingKey("turn-missing-audio-turn", "m-audio-missing-turn")),
      false,
    );
    assert.equal(
      sessionStore.getSession("turn-missing-audio-turn")?.segments.has("m-audio-missing-turn"),
      false,
    );
    assert.equal(
      adapter.state.pendingAssistantTexts.has(pendingKey("turn-missing-audio-turn", "m-audio-missing-turn")),
      false,
    );
  });
}

function testTurnStartedResetsPendingMaps(): void {
  withConnectedAdapter(({ adapter, socket }) => {
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "m-old",
      timestamp: "2026-05-08T00:00:00.000Z",
      turn_id: "turn-old",
      source: "backend",
      payload: { text: "queued", speaker_name: "assistant", avatar: "" },
    }));
    sendTurnStarted(socket, "turn-new");
    assert.equal(adapter.state.currentTurnId, "turn-new");
    assert.equal(adapter.state.pendingAssistantTexts.size, 0);
    assert.equal(adapter.state.pendingAudios.size, 0);
  });
}

function testSynthFinishedMarksMissingSegmentAudioAbsent(): void {
  withConnectedAdapter(({ socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-synth-finished");
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "m-no-audio",
      timestamp: "2026-05-08T00:00:01.000Z",
      turn_id: "turn-synth-finished",
      source: "backend",
      payload: { text: "no audio", speaker_name: "assistant", avatar: "" },
    }));
    socket.emitMessage(JSON.stringify({
      type: "control.synth_finished",
      version: "v2",
      message_id: "m-synth-finished",
      timestamp: "2026-05-08T00:00:02.000Z",
      turn_id: "turn-synth-finished",
      source: "backend",
      payload: {},
    }));

    const session = sessionStore.getSession("turn-synth-finished");
    assert.equal(session?.backend.synthFinished, true);
    assert.equal(session?.backend.turnFinished, false);
    assert.equal(session?.segments.get("m-no-audio")?.audio.terminal, "absent");
  });
}

function testSynthFinishedDoesNotMarkReleasedAudioAbsent(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-released-audio");
    sessionStore.markAudioReceived(
      "turn-released-audio",
      "http://localhost/audio.wav",
      "m-released-audio",
    );
    sessionStore.markAudioStarted(
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
      turn_id: "turn-released-audio",
      source: "backend",
      payload: {},
    }));

    const session = sessionStore.getSession("turn-released-audio");
    const segment = session?.segments.get("m-released-audio");
    assert.equal(segment?.audio.released, true);
    assert.notEqual(segment?.audio.terminal, "absent");
  });
}

async function testLateAudioAfterSynthFinishedStillPlaysOnce(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    sendTurnStarted(socket, "turn-late-audio");
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "msg-late-audio",
      timestamp: "2026-05-08T00:00:01.000Z",
      turn_id: "turn-late-audio",
      source: "backend",
      payload: { text: "late audio", speaker_name: "assistant", avatar: "" },
    }));

    sendSynthFinished(socket, "turn-late-audio", "synth-late-audio");
    await flushMicrotasks();

    const beforeAudio = sessionStore.getSession("turn-late-audio")?.segments.get("msg-late-audio");
    assert.equal(beforeAudio?.audio.terminal, "absent");

    sendOutputAudio(socket, {
      turnId: "turn-late-audio",
      messageId: "msg-late-audio",
      audioUrl: "http://127.0.0.1:12397/cache/audio/late.wav",
      captionText: "late audio",
    });
    await flushMicrotasks();

    const queuedAudio = sessionStore.getSession("turn-late-audio")?.segments.get("msg-late-audio");
    assert.equal(queuedAudio?.audio.terminal, "idle");
    assert.equal(adapter.state.pendingAudios.size, 1);
    assert.equal(adapter.playbackTimeline.releaseAudioForPlayback("msg-late-audio", "turn-late-audio"), true);
    await flushMicrotasks();

    const afterAudio = sessionStore.getSession("turn-late-audio")?.segments.get("msg-late-audio");
    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(adapter.state.isPlayingAudio, true);
    assert.equal(afterAudio?.audio.started, true);
    assert.equal(afterAudio?.audio.terminal, "idle");
    assert.equal(adapter.state.pendingAudios.size, 0);
  } finally {
    harness.scope.stop();
  }
}

async function testAudioTimelineStartedHandlerReceivesStartedSnapshot(): Promise<void> {
  const h = createConnectedAdapter();
  try {
    const { adapter, socket } = h;
    const started: Array<{
      turnId: string | null;
      messageId: string;
      phase: string | undefined;
      clockSource: string | undefined;
      durationMs: number | null | undefined;
    }> = [];
    adapter.playbackTimeline.setAudioTimelineStartedHandler((turnId, messageId, playbackTimeline) => {
      started.push({
        turnId,
        messageId,
        phase: playbackTimeline?.phase,
        clockSource: playbackTimeline?.clockSource,
        durationMs: playbackTimeline?.durationMs,
      });
    });

    sendTurnStarted(socket, "turn-audio-timeline");
    sendOutputAudio(socket, {
      turnId: "turn-audio-timeline",
      messageId: "msg-audio-timeline",
      audioUrl: "http://127.0.0.1:12397/cache/audio/timeline.wav",
    });

    assert.equal(adapter.playbackTimeline.releaseAudioForPlayback("msg-audio-timeline", "turn-audio-timeline"), true);
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(started, [
      {
        turnId: "turn-audio-timeline",
        messageId: "msg-audio-timeline",
        phase: "playing",
        clockSource: "audio",
        durationMs: 1250,
      },
    ]);
  } finally {
    h.scope.stop();
  }
}
async function testDuplicateOutputAudioDoesNotReplayCompletedSegment(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    sendTurnStarted(socket, "turn-duplicate-audio");
    sendOutputAudio(socket, {
      turnId: "turn-duplicate-audio",
      messageId: "msg-duplicate-audio",
      audioUrl: "http://127.0.0.1:12397/cache/audio/repeat.wav",
      captionText: "repeat audio",
    });

    assert.equal(adapter.playbackTimeline.releaseAudioForPlayback("msg-duplicate-audio", "turn-duplicate-audio"), true);
    await flushMicrotasks();
    FakeAudio.instances[0]?.emit("ended");
    await flushMicrotasks();

    const completed = sessionStore.getSession("turn-duplicate-audio")?.segments.get("msg-duplicate-audio");
    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(completed?.audio.terminal, "completed");

    sendOutputAudio(socket, {
      turnId: "turn-duplicate-audio",
      messageId: "msg-duplicate-audio",
      audioUrl: "http://127.0.0.1:12397/cache/audio/repeat.wav",
      captionText: "repeat audio",
    });
    await flushMicrotasks();

    const afterDuplicate = sessionStore.getSession("turn-duplicate-audio")?.segments.get("msg-duplicate-audio");
    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(adapter.state.pendingAudios.size, 0);
    assert.equal(afterDuplicate?.audio.terminal, "completed");
  } finally {
    harness.scope.stop();
  }
}

async function testChangedUrlOutputAudioDoesNotReplayCompletedSegment(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    sendTurnStarted(socket, "turn-changed-audio");
    sendOutputAudio(socket, {
      turnId: "turn-changed-audio",
      messageId: "msg-changed-audio",
      audioUrl: "http://127.0.0.1:12397/cache/audio/first.wav",
      captionText: "repeat audio",
    });

    assert.equal(adapter.playbackTimeline.releaseAudioForPlayback("msg-changed-audio", "turn-changed-audio"), true);
    await flushMicrotasks();
    FakeAudio.instances[0]?.emit("ended");
    await flushMicrotasks();

    const completed = sessionStore.getSession("turn-changed-audio")?.segments.get("msg-changed-audio");
    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(completed?.audio.url, "http://127.0.0.1:12397/cache/audio/first.wav");
    assert.equal(completed?.audio.terminal, "completed");

    sendOutputAudio(socket, {
      turnId: "turn-changed-audio",
      messageId: "msg-changed-audio",
      audioUrl: "http://127.0.0.1:12397/cache/audio/second.wav",
      captionText: "repeat audio",
    });
    await flushMicrotasks();

    const afterDuplicate = sessionStore.getSession("turn-changed-audio")?.segments.get("msg-changed-audio");
    assert.equal(FakeAudio.instances.length, 1);
    assert.equal(adapter.state.pendingAudios.size, 0);
    assert.equal(afterDuplicate?.audio.url, "http://127.0.0.1:12397/cache/audio/first.wav");
    assert.equal(afterDuplicate?.audio.terminal, "completed");
  } finally {
    harness.scope.stop();
  }
}

function testTurnFinishedDoesNotMarkMissingSegmentAudioAbsent(): void {
  withConnectedAdapter(({ socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-finished");
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "m-no-audio-turn-finished",
      timestamp: "2026-05-08T00:00:01.000Z",
      turn_id: "turn-finished",
      source: "backend",
      payload: { text: "no audio", speaker_name: "assistant", avatar: "" },
    }));
    socket.emitMessage(JSON.stringify({
      type: "control.turn_finished",
      version: "v2",
      message_id: "m-turn-finished",
      timestamp: "2026-05-08T00:00:02.000Z",
      turn_id: "turn-finished",
      source: "backend",
      payload: { success: true },
    }));

    const session = sessionStore.getSession("turn-finished");
    assert.equal(session?.backend.turnFinished, true);
    assert.equal(
      session?.segments.get("m-no-audio-turn-finished")?.audio.terminal,
      "idle",
    );
  });
}

function testMotionWithoutTurnIdIsRejected(): void {
  withConnectedAdapter(({ socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-motion");
    socket.emitMessage(JSON.stringify(motionIntentEnvelope("m-motion", null)));

    const session = sessionStore.getSession("turn-motion");
    assert.ok(session);
    assert.equal(session?.segments.has("m-motion"), false);
    assert.equal(sessionStore.getSessions().some((item) => item.id === "turn:turn-motion"), true);
  });
}

function testStaleSynthFinishedReportsProtocolViolation(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-current");
    socket.emitMessage(JSON.stringify({
      type: "control.synth_finished",
      version: "v2",
      message_id: "m-stale-synth",
      timestamp: "2026-05-08T00:00:02.000Z",
      turn_id: "turn-other",
      source: "backend",
      payload: {},
    }));

    assert.match(adapter.state.lastError, /does not exist/);
    assert.equal(sessionStore.getSession("turn-other"), undefined);
  });
}

async function testCurrentTurnFinishedCreatesMissingSession(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    socket.sent.length = 0;
    await adapter.sendText("hello without turn_started");
    const turnId = String(parseSentJsonMessages(socket)[0]?.turn_id ?? "");
    assert.ok(turnId);

    socket.emitMessage(JSON.stringify({
      type: "control.turn_finished",
      version: "v2",
      message_id: "m-current-finished",
      timestamp: "2026-05-08T00:00:02.000Z",
      turn_id: turnId,
      source: "backend",
      payload: { success: true },
    }));

    const session = sessionStore.getSession(turnId);
    assert.equal(session?.backend.turnStarted, true);
    assert.equal(session?.backend.turnFinished, true);
    assert.equal(adapter.state.lastError, "");
  } finally {
    harness.scope.stop();
  }
}

async function testCurrentSynthFinishedCreatesMissingSession(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    socket.sent.length = 0;
    await adapter.sendText("hello synth without turn_started");
    const turnId = String(parseSentJsonMessages(socket)[0]?.turn_id ?? "");
    assert.ok(turnId);

    socket.emitMessage(JSON.stringify({
      type: "control.synth_finished",
      version: "v2",
      message_id: "m-current-synth",
      timestamp: "2026-05-08T00:00:02.000Z",
      turn_id: turnId,
      source: "backend",
      payload: {},
    }));

    const session = sessionStore.getSession(turnId);
    assert.equal(session?.backend.turnStarted, true);
    assert.equal(session?.backend.synthFinished, true);
    assert.equal(adapter.state.lastError, "");
  } finally {
    harness.scope.stop();
  }
}

function testInvalidMotionDoesNotRewritePreviousSegment(): void {
  withConnectedAdapter(({ socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-motion-old");
    socket.emitMessage(JSON.stringify(motionIntentEnvelope("m-motion-valid", "turn-motion-old")));

    const beforeSessionCount = sessionStore.getSessions().length;
    const previousPayload =
      sessionStore.getSession("turn-motion-old")?.segments.get("m-motion-valid")?.motion.payload;

    socket.emitMessage(JSON.stringify({
      type: "engine.motion_intent",
      version: "v2",
      message_id: "m-motion-invalid",
      timestamp: "2026-05-08T00:00:04.000Z",
      turn_id: "turn-motion-old",
      source: "backend",
      payload: {
        mode: "preview",
        intent: { schema_version: "engine.motion_intent.v1" },
      },
    }));

    assert.deepEqual(
      sessionStore.getSession("turn-motion-old")?.segments.get("m-motion-valid")?.motion.payload,
      previousPayload,
    );
    assert.equal(sessionStore.getSessions().length, beforeSessionCount);
  });
}

function testBackToBackTurnsDoNotSharePendingState(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    // Turn A
    sendTurnStarted(socket, "turn-a");
    socket.emitMessage(JSON.stringify({
      type: "output.text",
      version: "v2",
      message_id: "m-a",
      timestamp: "2026-05-08T00:00:01.000Z",
      turn_id: "turn-a",
      source: "backend",
      payload: { text: "text a", speaker_name: "assistant", avatar: "" },
    }));

    assert.ok(adapter.state.pendingAssistantTexts.has(pendingKey("turn-a", "m-a")));

    // Turn B starts, should clear Turn A's pending state
    sendTurnStarted(socket, "turn-b");
    assert.equal(adapter.state.currentTurnId, "turn-b");
    assert.equal(adapter.state.pendingAssistantTexts.size, 0);
    assert.equal(adapter.state.pendingAudios.size, 0);

    // Turn A's session should still exist for diagnostics
    assert.ok(sessionStore.getSession("turn-a"));
  });
}

function testStaleTurnFinishedDoesNotMarkCurrentTurnCompleted(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-current");

    // Send turn_finished for a DIFFERENT turn_id
    socket.emitMessage(JSON.stringify({
      type: "control.turn_finished",
      version: "v2",
      message_id: "m-stale",
      timestamp: "2026-05-08T00:00:02.000Z",
      turn_id: "turn-other",
      source: "backend",
      payload: { success: true },
    }));

    // Current turn should NOT be marked as finished
    const session = sessionStore.getSession("turn-current");
    assert.ok(session);
    assert.equal(session.backend.turnFinished, false);
    assert.equal(sessionStore.getSession("turn-other"), undefined);
    assert.match(adapter.state.lastError, /does not exist/);
  });
}

function testScopeDisposeDisconnectsAdapterRuntime(): void {
  const harness = createConnectedAdapter();
  const { adapter, socket, scope } = harness;
  assert.equal(adapter.state.status, "connected");
  assert.equal(socket.readyState, FakeWebSocket.OPEN);

  scope.stop();

  assert.equal(adapter.state.status, "disconnected");
  assert.equal(adapter.state.statusMessage, "已断开适配器连接。");
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
}

async function testSendTextUsesOutboundProtocolEnvelope(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket } = harness;
    socket.sent.length = 0;

    const sent = await adapter.sendText(" hello outbound ");

    assert.equal(sent, true);
    assert.equal(socket.sent.length, 1);
    const message = parseSentJsonMessages(socket)[0];
    assert.ok(message);
    assert.equal(message.type, "input.text");
    assert.equal(message.version, "v2");
    assert.equal(typeof message.message_id, "string");
    assert.equal(typeof message.turn_id, "string");
    assert.deepEqual(message.payload, {
      text: "hello outbound",
      images: [],
    });
    assert.equal(adapter.state.lastError, "");
    assert.equal(adapter.state.statusMessage, "文本已发送，等待后端回复。");
  } finally {
    harness.scope.stop();
  }
}

function testSendMotionPreviewUsesOutboundProtocolEnvelope(): void {
  withConnectedAdapter(({ adapter, socket }) => {
    socket.sent.length = 0;

    const sent = adapter.sendMotionPayloadPreview({
      schema_version: "engine.motion_intent.v3",
      profile_id: "profile-1",
      profile_revision: 1,
      model_id: "model-1",
      mode: "expressive",
      intent_tags: ["happy", "preview"],
      emotion_label: "happy",
      axes: {
        head_yaw: 62,
      },
    });

    assert.equal(sent, true);
    assert.equal(socket.sent.length, 1);
    const message = parseSentJsonMessages(socket)[0];
    assert.ok(message);
    assert.equal(message.type, "engine.motion_intent");
    assert.equal(message.version, "v2");
    assert.deepEqual(message.payload, {
      mode: "preview",
      intent: {
        schema_version: "engine.motion_intent.v3",
        profile_id: "profile-1",
        profile_revision: 1,
        model_id: "model-1",
        mode: "expressive",
        intent_tags: ["happy", "preview"],
        emotion_label: "happy",
        axes: {
          head_yaw: 62,
        },
      },
    });
    assert.equal(adapter.state.statusMessage, "已发送动作测试载荷（engine.motion_intent）。");
  });
}

function testSendMotionPreviewRejectsV3PayloadWithoutIntentTags(): void {
  withConnectedAdapter(({ adapter, socket }) => {
    socket.sent.length = 0;

    const sent = adapter.sendMotionPayloadPreview({
      schema_version: "engine.motion_intent.v3",
      profile_id: "profile-1",
      profile_revision: 1,
      model_id: "model-1",
      mode: "expressive",
      emotion_label: "happy",
      axes: {
        head_yaw: 62,
      },
    });

    assert.equal(sent, false);
    assert.equal(socket.sent.length, 0);
    assert.equal(
      adapter.state.lastError,
      "动作测试载荷无效：engine.motion_intent.v3 缺少 intent_tags。",
    );
  });
}

function testSendParameterPlanPayloadPreviewIsRejected(): void {
  withConnectedAdapter(({ adapter, socket }) => {
    socket.sent.length = 0;

    const sent = adapter.sendMotionPayloadPreview({
      schema_version: "engine.parameter_plan.v2",
      profile_id: "profile-1",
      profile_revision: 1,
      model_id: "model-1",
      mode: "expressive",
      emotion_label: "happy",
      timing: {
        duration_ms: 1200,
        blend_in_ms: 180,
        hold_ms: 760,
        blend_out_ms: 260,
      },
      parameters: [
        {
          axis_id: "head_yaw",
          parameter_id: "ParamAngleX",
          target_value: 12,
          weight: 1,
          input_value: 70,
          source: "semantic_axis",
        },
      ],
    });

    assert.equal(sent, false);
    assert.equal(socket.sent.length, 0);
    assert.match(adapter.state.statusMessage, /不支持 schema_version=engine\.parameter_plan\.v2/);
  });
}

async function testAutoStartMicIsIgnoredInPttMode(): Promise<void> {
  // pttModeEnabled defaults to true — both auto_start_mic and control.start_mic must be skipped
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket } = harness;
    socket.emitMessage(JSON.stringify({
      type: "system.server_info",
      version: "v2",
      message_id: "server-info-1",
      timestamp: "2026-05-08T00:00:00.000Z",
      turn_id: null,
      source: "adapter",
      payload: { ws_url: "ws://127.0.0.1:12396", http_base_url: "http://127.0.0.1:12397", auto_start_mic: true },
    }));
    socket.emitMessage(JSON.stringify({
      type: "control.start_mic",
      version: "v2",
      message_id: "start-mic-1",
      timestamp: "2026-05-08T00:00:00.001Z",
      turn_id: null,
      source: "adapter",
      payload: {},
    }));
    await flushMicrotasks();
    assert.equal(adapter.state.micCapturing, false);
    assert.equal(adapter.state.micRequested, false);
  } finally {
    harness.scope.stop();
  }
}

async function testAutoStartMicDoesNotDuplicateCaptureStart(): Promise<void> {
  // always-on mode: auto_start_mic + control.start_mic should start mic exactly once
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket } = harness;
    adapter.setPttMode(false);
    socket.emitMessage(JSON.stringify({
      type: "system.server_info",
      version: "v2",
      message_id: "server-info-1",
      timestamp: "2026-05-08T00:00:00.000Z",
      turn_id: null,
      source: "adapter",
      payload: { ws_url: "ws://127.0.0.1:12396", http_base_url: "http://127.0.0.1:12397", auto_start_mic: true },
    }));
    socket.emitMessage(JSON.stringify({
      type: "control.start_mic",
      version: "v2",
      message_id: "start-mic-1",
      timestamp: "2026-05-08T00:00:00.001Z",
      turn_id: null,
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

async function testManualMicAudioStreamsBinaryFramesForVad(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket } = harness;
    sendTurnStarted(socket, "turn-playback");

    const started = await adapter.toggleMicrophoneCapture();
    assert.equal(started, true);
    const worklet = FakeAudioWorkletNode.instances[0];
    assert.ok(worklet);

    socket.sent.length = 0;
    worklet.emitChunk(new Float32Array([0.2, -0.1, 0.05]));
    await flushMicrotasks();
    await adapter.toggleMicrophoneCapture();

    const jsonMessages = parseSentJsonMessages(socket);
    const startMessage = jsonMessages.find((item) => item.type === "input.audio_stream_start");
    const endMessage = jsonMessages.find((item) => item.type === "input.audio_stream_end");
    const binaryFrame = sentBinaryFrames(socket)[0];
    assert.ok(startMessage);
    assert.ok(endMessage);
    assert.ok(binaryFrame);
    const metadata = parseAudioFrameMetadata(binaryFrame);

    assert.equal(typeof startMessage?.turn_id, "string");
    assert.equal(startMessage?.turn_id, endMessage?.turn_id);
    assert.equal(startMessage?.turn_id, metadata.turn_id);
    assert.notEqual(startMessage?.turn_id, "turn-playback");
    assert.match(String(startMessage?.turn_id), /^input:/);
    assert.equal((startMessage?.payload as Record<string, unknown>).stream_id, metadata.stream_id);
    assert.equal((startMessage?.payload as Record<string, unknown>).capture_mode, "manual");
    assert.equal(metadata.encoding, "pcm16le");
    assert.equal(metadata.capture_mode, "manual");
    assert.deepEqual(endMessage?.payload, {
      stream_id: metadata.stream_id,
      reason: "manual_stop",
      dropped: false,
      last_seq: 0,
      capture_mode: "manual",
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
      socket.sent.some((item) =>
        typeof item === "string" && item.includes("\"input.audio_stream_start\"")
      ),
      false,
    );

    socket.bufferedAmount = 0;
    await adapter.toggleMicrophoneCapture();

    const micEndMessage = parseSentJsonMessages(socket)
      .find((item) => item.type === "input.mic_audio_end");
    const streamEndMessage = parseSentJsonMessages(socket)
      .find((item) => item.type === "input.audio_stream_end");
    assert.ok(streamEndMessage ?? micEndMessage);
    const endPayload = (streamEndMessage ?? micEndMessage)?.payload as Record<string, unknown>;
    assert.equal(endPayload.dropped, true);
    assert.equal(endPayload.capture_mode, "manual");
    assert.equal(endPayload.reason, "manual_stop");
    if (streamEndMessage) {
      return;
    }
    assert.deepEqual(micEndMessage?.payload, {
      reason: "manual_stop",
      dropped: true,
      capture_mode: "manual",
    });
  } finally {
    harness.scope.stop();
  }
}

async function testSendTextDoesNotInterruptIdleCurrentTurn(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket } = harness;
    sendTurnStarted(socket, "turn-idle-current");
    socket.sent.length = 0;

    const sent = await adapter.sendText("next message after idle turn");
    assert.equal(sent, true);

    assert.deepEqual(
      parseSentJsonMessages(socket).map((item) => item.type),
      ["input.text"],
    );
  } finally {
    harness.scope.stop();
  }
}

async function testSendTextSettlesPlayingAudioBeforeNewInput(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    sendTurnStarted(socket, "turn-before-new-input");
    sendOutputAudio(socket, {
      turnId: "turn-before-new-input",
      messageId: "msg-before-new-input",
      audioUrl: "http://127.0.0.1:12397/cache/audio/before-new-input.wav",
    });
    assert.equal(adapter.playbackTimeline.releaseAudioForPlayback(
      "msg-before-new-input",
      "turn-before-new-input",
    ), true);
    await flushMicrotasks();

    const beforeSegment = sessionStore
      .getSession("turn-before-new-input")
      ?.segments.get("msg-before-new-input");
    assert.equal(beforeSegment?.audio.terminal, "idle");
    assert.equal(adapter.state.isPlayingAudio, true);

    socket.sent.length = 0;
    const sent = await adapter.sendText("new input while speaking");
    assert.equal(sent, true);

    const afterSegment = sessionStore
      .getSession("turn-before-new-input")
      ?.segments.get("msg-before-new-input");
    assert.equal(afterSegment?.audio.terminal, "failed");
    assert.equal(afterSegment?.audio.reason, "audio_playback_replaced_by_new_input");
    assert.equal(adapter.state.isPlayingAudio, false);
    assert.deepEqual(
      parseSentJsonMessages(socket).map((item) => item.type),
      ["control.interrupt", "input.text"],
    );
  } finally {
    harness.scope.stop();
  }
}

async function testSendTextSettlesPendingAudioBeforeNewInput(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    sendTurnStarted(socket, "turn-pending-before-new-input");
    sendOutputAudio(socket, {
      turnId: "turn-pending-before-new-input",
      messageId: "msg-pending-before-new-input",
      audioUrl: "http://127.0.0.1:12397/cache/audio/pending-before-new-input.wav",
    });
    assert.equal(
      adapter.state.pendingAudios.has(pendingKey("turn-pending-before-new-input", "msg-pending-before-new-input")),
      true,
    );

    socket.sent.length = 0;
    assert.equal(await adapter.sendText("new input while audio pending"), true);

    const segment = sessionStore
      .getSession("turn-pending-before-new-input")
      ?.segments.get("msg-pending-before-new-input");
    assert.equal(segment?.audio.terminal, "failed");
    assert.equal(segment?.audio.reason, "audio_playback_replaced_by_new_input");
    assert.equal(
      adapter.state.pendingAudios.has(pendingKey("turn-pending-before-new-input", "msg-pending-before-new-input")),
      false,
    );
    assert.deepEqual(
      parseSentJsonMessages(socket).map((item) => item.type),
      ["control.interrupt", "input.text"],
    );
  } finally {
    harness.scope.stop();
  }
}

async function testClearPlaybackGroupOnlySettlesTargetTurnAudio(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    sendTurnStarted(socket, "turn-clear-target");
    sendOutputAudio(socket, {
      turnId: "turn-clear-target",
      messageId: "msg-clear-target-audio",
      audioUrl: "http://127.0.0.1:12397/cache/audio/clear-target.wav",
    });
    assert.equal(adapter.playbackTimeline.releaseAudioForPlayback(
      "msg-clear-target-audio",
      "turn-clear-target",
    ), true);
    await flushMicrotasks();

    sendTurnStarted(socket, "turn-clear-current");
    sendOutputAudio(socket, {
      turnId: "turn-clear-current",
      messageId: "msg-clear-current-pending",
      audioUrl: "http://127.0.0.1:12397/cache/audio/clear-current.wav",
    });
    assert.equal(adapter.state.currentTurnId, "turn-clear-current");
    assert.equal(
      adapter.state.pendingAudios.has(pendingKey("turn-clear-current", "msg-clear-current-pending")),
      true,
    );

    adapter.clearPlaybackGroupContext("turn-clear-target");

    const targetSegment = sessionStore
      .getSession("turn-clear-target")
      ?.segments.get("msg-clear-target-audio");
    const currentSegment = sessionStore
      .getSession("turn-clear-current")
      ?.segments.get("msg-clear-current-pending");
    assert.equal(targetSegment?.audio.terminal, "failed");
    assert.equal(targetSegment?.audio.reason, "playback_group_cleared");
    assert.equal(adapter.state.isPlayingAudio, false);
    assert.equal(adapter.state.currentTurnId, "turn-clear-current");
    assert.equal(
      adapter.state.pendingAudios.has(pendingKey("turn-clear-current", "msg-clear-current-pending")),
      true,
    );
    assert.equal(currentSegment?.audio.terminal, "idle");
  } finally {
    harness.scope.stop();
  }
}

async function testInboundInterruptOnlySettlesTargetTurnAudio(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    sendTurnStarted(socket, "turn-inbound-interrupt-target");
    sendOutputAudio(socket, {
      turnId: "turn-inbound-interrupt-target",
      messageId: "msg-inbound-interrupt-target-audio",
      audioUrl: "http://127.0.0.1:12397/cache/audio/inbound-interrupt-target.wav",
    });
    assert.equal(adapter.playbackTimeline.releaseAudioForPlayback(
      "msg-inbound-interrupt-target-audio",
      "turn-inbound-interrupt-target",
    ), true);
    await flushMicrotasks();

    sendTurnStarted(socket, "turn-inbound-interrupt-current");
    sendOutputAudio(socket, {
      turnId: "turn-inbound-interrupt-current",
      messageId: "msg-inbound-interrupt-current-pending",
      audioUrl: "http://127.0.0.1:12397/cache/audio/inbound-interrupt-current.wav",
    });

    socket.emitMessage(JSON.stringify({
      type: "control.interrupt",
      version: "v2",
      message_id: "interrupt-target-only",
      timestamp: "2026-05-08T00:00:21.000Z",
      turn_id: "turn-inbound-interrupt-target",
      source: "backend",
      payload: {},
    }));

    const targetSegment = sessionStore
      .getSession("turn-inbound-interrupt-target")
      ?.segments.get("msg-inbound-interrupt-target-audio");
    const currentSegment = sessionStore
      .getSession("turn-inbound-interrupt-current")
      ?.segments.get("msg-inbound-interrupt-current-pending");
    assert.equal(targetSegment?.audio.terminal, "failed");
    assert.equal(targetSegment?.audio.reason, "audio_playback_interrupted");
    assert.equal(adapter.state.isPlayingAudio, false);
    assert.equal(adapter.state.currentTurnId, "turn-inbound-interrupt-current");
    assert.equal(
      adapter.state.pendingAudios.has(pendingKey("turn-inbound-interrupt-current", "msg-inbound-interrupt-current-pending")),
      true,
    );
    assert.equal(currentSegment?.audio.terminal, "idle");
  } finally {
    harness.scope.stop();
  }
}

function testDisconnectSettlesPendingAudioBeforeClearingQueue(): void {
  withConnectedAdapter(({ adapter, socket, sessionStore }) => {
    sendTurnStarted(socket, "turn-disconnect-pending");
    sendOutputAudio(socket, {
      turnId: "turn-disconnect-pending",
      messageId: "msg-disconnect-pending",
      audioUrl: "http://127.0.0.1:12397/cache/audio/disconnect-pending.wav",
    });
    assert.equal(
      adapter.state.pendingAudios.has(pendingKey("turn-disconnect-pending", "msg-disconnect-pending")),
      true,
    );

    adapter.disconnect();

    const segment = sessionStore
      .getSession("turn-disconnect-pending")
      ?.segments.get("msg-disconnect-pending");
    assert.equal(adapter.state.pendingAudios.size, 0);
    assert.equal(segment?.audio.terminal, "failed");
    assert.equal(segment?.audio.reason, "manual_disconnect");
  });
}

async function testPttReleaseDuringStartupStopsCaptureAfterStart(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket } = harness;
    adapter.setPttMode(true);
    deferNextGetUserMedia();

    const startPromise = adapter.startPttCapture();
    await flushMicrotasks();
    assert.equal(adapter.state.micCapturing, false);

    await adapter.stopPttCapture();
    deferredGetUserMedia?.resolve();
    assert.equal(await startPromise, "discarded");
    await flushMicrotasks();

    assert.equal(adapter.state.micCapturing, false);
    assert.equal(adapter.state.micRequested, false);
    assert.equal(adapter.state.statusMessage, "按键时间过短，未开始识别。");
    assert.equal(
      parseSentJsonMessages(socket).some((item) =>
        item.type === "input.mic_audio_end" || item.type === "input.audio_stream_end"
      ),
      false,
    );
  } finally {
    harness.scope.stop();
  }
}

async function testDeviceChangeEndsPreviousMicSegmentBeforeRestart(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket } = harness;
    adapter.setMicrophoneDevices([
      { deviceId: "mic-a", label: "Mic A" },
      { deviceId: "mic-b", label: "Mic B" },
    ]);
    adapter.setMicrophoneDevice("mic-a");

    const started = await adapter.toggleMicrophoneCapture();
    assert.equal(started, true);
    const firstWorklet = FakeAudioWorkletNode.instances[0];
    assert.ok(firstWorklet);

    socket.sent.length = 0;
    firstWorklet.emitChunk(new Float32Array([0.1, 0.2]));
    await flushMicrotasks();

    const firstStartMessage = parseSentJsonMessages(socket)
      .find((item) => item.type === "input.audio_stream_start");
    assert.ok(firstStartMessage);
    const firstTurnId = String(firstStartMessage?.turn_id ?? "");
    assert.match(firstTurnId, /^input:/);

    socket.sent.length = 0;
    adapter.setMicrophoneDevice("mic-b");
    await flushMicrotasks();

    const restartEndMessage = parseSentJsonMessages(socket)
      .find((item) => item.type === "input.audio_stream_end");
    assert.ok(restartEndMessage);
    assert.equal(restartEndMessage?.turn_id, firstTurnId);
    assert.deepEqual(restartEndMessage?.payload, {
      stream_id: (firstStartMessage?.payload as Record<string, unknown>).stream_id,
      reason: "device_change",
      dropped: false,
      last_seq: 0,
      capture_mode: "manual",
    });

    const secondWorklet = FakeAudioWorkletNode.instances.at(-1);
    assert.ok(secondWorklet);
    assert.notEqual(secondWorklet, firstWorklet);

    secondWorklet?.emitChunk(new Float32Array([0.4, -0.4]));
    await flushMicrotasks();
    const latestStartMessage = parseSentJsonMessages(socket)
      .reverse()
      .find((item) => item.type === "input.audio_stream_start");
    assert.ok(latestStartMessage);
    assert.notEqual(latestStartMessage?.turn_id, firstTurnId);
    assert.match(String(latestStartMessage?.turn_id), /^input:/);
  } finally {
    harness.scope.stop();
  }
}

async function testInterruptMarksPlayingAudioSegmentFailed(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    sendTurnStarted(socket, "turn-interrupt");
    socket.emitMessage(JSON.stringify({
      type: "output.audio",
      version: "v2",
      message_id: "msg-interrupt-audio",
      timestamp: "2026-05-08T00:00:20.000Z",
      turn_id: "turn-interrupt",
      source: "backend",
      payload: {
        audio_url: "http://127.0.0.1:12397/cache/audio/test.wav",
        caption_text: "hello",
        speaker_name: "Alice",
        avatar: "",
      },
    }));

    const released = adapter.playbackTimeline.releaseAudioForPlayback(
      "msg-interrupt-audio",
      "turn-interrupt",
    );
    assert.equal(released, true);
    await flushMicrotasks();

    const sessionBeforeInterrupt = sessionStore.getSession("turn-interrupt");
    const segmentBeforeInterrupt = sessionBeforeInterrupt?.segments.get("msg-interrupt-audio");
    assert.equal(segmentBeforeInterrupt?.audio.started, true);
    assert.equal(adapter.state.isPlayingAudio, true);

    socket.emitMessage(JSON.stringify({
      type: "control.interrupt",
      version: "v2",
      message_id: "interrupt-1",
      timestamp: "2026-05-08T00:00:21.000Z",
      turn_id: "turn-interrupt",
      source: "backend",
      payload: {},
    }));

    const sessionAfterInterrupt = sessionStore.getSession("turn-interrupt");
    const segmentAfterInterrupt = sessionAfterInterrupt?.segments.get("msg-interrupt-audio");
    assert.equal(adapter.state.isPlayingAudio, false);
    assert.equal(segmentAfterInterrupt?.audio.terminal, "failed");
    assert.equal(segmentAfterInterrupt?.audio.reason, "audio_playback_interrupted");
  } finally {
    harness.scope.stop();
  }
}

function testUserInterruptWithoutTurnIdentityIsRejected(): void {
  withConnectedAdapter(({ adapter, socket }) => {
    socket.sent.length = 0;

    const interrupted = adapter.interruptCurrentTurn();

    assert.equal(interrupted, false);
    assert.equal(adapter.state.lastError, "当前没有可中断的轮次。");
    assert.equal(
      parseSentJsonMessages(socket).some((item) => item.type === "control.interrupt"),
      false,
    );
  });
}

async function testUserInterruptMarksPlayingAudioSegmentFailedBeforeSending(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    sendTurnStarted(socket, "turn-user-interrupt");
    sendOutputAudio(socket, {
      turnId: "turn-user-interrupt",
      messageId: "msg-user-interrupt-audio",
      audioUrl: "http://127.0.0.1:12397/cache/audio/user-interrupt.wav",
    });
    assert.equal(adapter.playbackTimeline.releaseAudioForPlayback(
      "msg-user-interrupt-audio",
      "turn-user-interrupt",
    ), true);
    await flushMicrotasks();

    socket.sent.length = 0;
    const interrupted = adapter.interruptCurrentTurn();
    assert.equal(interrupted, true);

    const segment = sessionStore
      .getSession("turn-user-interrupt")
      ?.segments.get("msg-user-interrupt-audio");
    assert.equal(segment?.audio.terminal, "failed");
    assert.equal(segment?.audio.reason, "audio_playback_interrupted");
    assert.equal(adapter.state.isPlayingAudio, false);
    assert.equal(
      parseSentJsonMessages(socket).some((item) => item.type === "control.interrupt"),
      true,
    );
  } finally {
    harness.scope.stop();
  }
}

async function testUserInterruptMarksPendingAudioSegmentFailedBeforeSending(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    sendTurnStarted(socket, "turn-user-interrupt-pending");
    sendOutputAudio(socket, {
      turnId: "turn-user-interrupt-pending",
      messageId: "msg-user-interrupt-pending-audio",
      audioUrl: "http://127.0.0.1:12397/cache/audio/user-interrupt-pending.wav",
    });
    assert.equal(
      adapter.state.pendingAudios.has(pendingKey("turn-user-interrupt-pending", "msg-user-interrupt-pending-audio")),
      true,
    );

    socket.sent.length = 0;
    assert.equal(adapter.interruptCurrentTurn(), true);

    const segment = sessionStore
      .getSession("turn-user-interrupt-pending")
      ?.segments.get("msg-user-interrupt-pending-audio");
    assert.equal(segment?.audio.terminal, "failed");
    assert.equal(segment?.audio.reason, "audio_playback_interrupted");
    assert.equal(
      adapter.state.pendingAudios.has(pendingKey("turn-user-interrupt-pending", "msg-user-interrupt-pending-audio")),
      false,
    );
    assert.equal(
      parseSentJsonMessages(socket).some((item) => item.type === "control.interrupt"),
      true,
    );
  } finally {
    harness.scope.stop();
  }
}

async function testInterruptMarksPendingAudioSegmentFailedBeforePlaybackStart(): Promise<void> {
  const harness = createConnectedAdapter();
  try {
    const { adapter, socket, sessionStore } = harness;
    sendTurnStarted(socket, "turn-interrupt-pending");
    socket.emitMessage(JSON.stringify({
      type: "output.audio",
      version: "v2",
      message_id: "msg-interrupt-pending-audio",
      timestamp: "2026-05-08T00:00:22.000Z",
      turn_id: "turn-interrupt-pending",
      source: "backend",
      payload: {
        audio_url: "http://127.0.0.1:12397/cache/audio/test-pending.wav",
        caption_text: "hello pending",
        speaker_name: "Alice",
        avatar: "",
      },
    }));

    FakeAudio.nextPlayShouldStall = true;
    const released = adapter.playbackTimeline.releaseAudioForPlayback(
      "msg-interrupt-pending-audio",
      "turn-interrupt-pending",
    );
    assert.equal(released, true);

    socket.emitMessage(JSON.stringify({
      type: "control.interrupt",
      version: "v2",
      message_id: "interrupt-pending-1",
      timestamp: "2026-05-08T00:00:23.000Z",
      turn_id: "turn-interrupt-pending",
      source: "backend",
      payload: {},
    }));

    const sessionAfterInterrupt = sessionStore.getSession("turn-interrupt-pending");
    const segmentAfterInterrupt = sessionAfterInterrupt?.segments.get("msg-interrupt-pending-audio");
    assert.equal(adapter.state.isPlayingAudio, false);
    assert.equal(segmentAfterInterrupt?.audio.terminal, "failed");
    assert.equal(segmentAfterInterrupt?.audio.reason, "audio_playback_interrupted");
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
  testSameMessageIdAcrossTurnsDoesNotOverwritePendingItems();
  testOutputAudioWithoutTurnIdIsRejected();
  testTurnStartedResetsPendingMaps();
  testSynthFinishedMarksMissingSegmentAudioAbsent();
  testSynthFinishedDoesNotMarkReleasedAudioAbsent();
  await testLateAudioAfterSynthFinishedStillPlaysOnce();
  await testAudioTimelineStartedHandlerReceivesStartedSnapshot();
  await testDuplicateOutputAudioDoesNotReplayCompletedSegment();
  await testChangedUrlOutputAudioDoesNotReplayCompletedSegment();
  testTurnFinishedDoesNotMarkMissingSegmentAudioAbsent();
  testStaleSynthFinishedReportsProtocolViolation();
  await testCurrentTurnFinishedCreatesMissingSession();
  await testCurrentSynthFinishedCreatesMissingSession();
  testMotionWithoutTurnIdIsRejected();
  testInvalidMotionDoesNotRewritePreviousSegment();
  testBackToBackTurnsDoNotSharePendingState();
  testStaleTurnFinishedDoesNotMarkCurrentTurnCompleted();
  testScopeDisposeDisconnectsAdapterRuntime();
  await testSendTextUsesOutboundProtocolEnvelope();
  await testSendTextDoesNotInterruptIdleCurrentTurn();
  await testSendTextSettlesPlayingAudioBeforeNewInput();
  await testSendTextSettlesPendingAudioBeforeNewInput();
  await testClearPlaybackGroupOnlySettlesTargetTurnAudio();
  await testInboundInterruptOnlySettlesTargetTurnAudio();
  testDisconnectSettlesPendingAudioBeforeClearingQueue();
  testSendMotionPreviewUsesOutboundProtocolEnvelope();
  testSendMotionPreviewRejectsV3PayloadWithoutIntentTags();
  testSendParameterPlanPayloadPreviewIsRejected();
  await testAutoStartMicIsIgnoredInPttMode();
  await testAutoStartMicDoesNotDuplicateCaptureStart();
  await testManualMicAudioStreamsBinaryFramesForVad();
  await testMicAudioDropMarksBrokenSequenceAndReportsDroppedEnd();
  await testPttReleaseDuringStartupStopsCaptureAfterStart();
  await testDeviceChangeEndsPreviousMicSegmentBeforeRestart();
  await testInterruptMarksPlayingAudioSegmentFailed();
  testUserInterruptWithoutTurnIdentityIsRejected();
  await testUserInterruptMarksPlayingAudioSegmentFailedBeforeSending();
  await testUserInterruptMarksPendingAudioSegmentFailedBeforeSending();
  await testInterruptMarksPendingAudioSegmentFailedBeforePlaybackStart();

  console.log("useAdapterConnection tests passed");
}

void run();
