// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { createDesktopBridge } from "../src/desktop-bridge/useDesktopBridge.js";
import {
  defaultSnapshot,
  normalizeSnapshot,
} from "../src/desktop-bridge/snapshot/runtimeSnapshot.js";
import type { DesktopRuntimeSnapshot } from "../src/types/desktop.js";

class StrictBroadcastChannel {
  static readonly messages: unknown[] = [];

  constructor(_name: string) {}

  addEventListener(): void {}

  postMessage(message: unknown): void {
    structuredClone(message);
    StrictBroadcastChannel.messages.push(message);
  }

  close(): void {}
}

function installWindowStubs(): void {
  const storage = new Map<string, string>();
  window.localStorage = {
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
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  };
  window.addEventListener = () => {};
  window.removeEventListener = () => {};
  Object.assign(globalThis, {
    BroadcastChannel: StrictBroadcastChannel,
  });
}

function testPublishSnapshotStripsUncloneableRuntimeValues(): void {
  installWindowStubs();
  StrictBroadcastChannel.messages.length = 0;

  const bridge = createDesktopBridge();
  bridge.start();

  const snapshot = {
    ...defaultSnapshot,
    motionPlaybackRecords: [
      {
        id: "motion-1",
        createdAt: "2026-06-05T00:00:00.000Z",
        source: "playback_timeline_started",
        payloadKind: "catalog_motion",
        messageId: "message-1",
        turnId: "turn-1",
        playbackTurnId: "turn-1",
        modelName: "model-1",
        emotionLabel: "happy",
        mode: "expressive",
        startReason: "playback_timeline_started",
        queuedDelayMs: 90,
        assistantText: "hello",
        playerMessage: "playing",
        diagnostics: {
          usedActionLibrary: false,
          compiledParameterCount: 1,
          timingSource: "audio_sync",
          resolvedMode: "expressive",
          intensityApplied: false,
          motionIntensityScale: 1,
          axisIntensityScale: {},
          transformTrace: {
            transformVersion: "semantic_motion_transform.v3",
            profileRevision: 2,
            profileHash: "hash",
            rawAxes: {},
            rawAxisLevels: { head_yaw: 2 },
            axisSampling: {
              seed: "turn-1|message-1|hash|semantic_motion_transform.v3",
              sharedRandom: 0.1,
              perAxisRandom: { head_yaw: -0.2 },
              sampledValues: { head_yaw: 64.2 },
              sampleBounds: { head_yaw: { min: 60, max: 67 } },
            },
            resolvedAxes: { head_yaw: 64.2 },
            derivedAxes: {},
            constrainedAxes: { head_yaw: 64.2 },
            relationAdjustments: [],
            compiledParameters: ["ParamAngleX"],
          },
        },
        motion: {
          schema_version: "engine.catalog_motion.v1",
          model_id: "model-1",
          motion_id: "wave",
          group: "TapBody",
          index: 0,
          file: "Motions/wave.motion3.json",
          label: "Wave",
          emotion_label: "happy",
          duration_ms: 1200,
          priority: 3,
        },
        plan: null,
      },
      {
        id: "motion-speech-only",
        createdAt: "2026-06-05T00:00:01.000Z",
        source: "playback_timeline_started",
        payloadKind: "speech_only",
        messageId: "message-speech-only",
        turnId: "turn-1",
        playbackTurnId: "turn-1",
        modelName: "model-1",
        emotionLabel: "speech",
        mode: "idle",
        startReason: "speech_only",
        queuedDelayMs: 0,
        assistantText: "hello",
        playerMessage: "playing",
        diagnostics: null,
        plan: {
          schema_version: "engine.parameter_plan.v2",
          profile_id: "profile-1",
          profile_revision: 1,
          model_id: "model-1",
          mode: "idle",
          emotion_label: "speech",
          timing: {
            duration_ms: 1000,
            blend_in_ms: 100,
            hold_ms: 700,
            blend_out_ms: 200,
          },
          parameters: [{
            axis_id: "head_yaw",
            parameter_id: "ParamAngleX",
            target_value: 3,
            neutral_target_value: 0,
            weight: 1,
            input_value: 53,
            source: "speech_pose",
            dynamics: {
              max_velocity: 24,
              max_acceleration: 72,
              life_motion_scale: 0.2,
              max_speech_offset: 4,
            },
          }],
        },
      },
    ],
    historyEntries: [
      {
        id: "entry-1",
        role: "system",
        text: "ptt changed",
        timestamp: "2026-06-05T00:00:00.000Z",
        uncloneable: () => "boom",
      },
    ],
  } as unknown as DesktopRuntimeSnapshot;

  assert.doesNotThrow(() => {
    bridge.publishSnapshot(snapshot);
  });

  const message = StrictBroadcastChannel.messages[0] as {
    kind: string;
    snapshot: DesktopRuntimeSnapshot & {
      historyEntries: Array<Record<string, unknown>>;
    };
  };
  assert.equal(message.kind, "snapshot");
  assert.equal(message.snapshot.historyEntries[0]?.text, "ptt changed");
  assert.equal("uncloneable" in (message.snapshot.historyEntries[0] ?? {}), false);
  assert.equal(
    message.snapshot.motionPlaybackRecords[0]?.diagnostics?.transformTrace
      ?.axisSampling?.sampledValues.head_yaw,
    64.2,
  );
  assert.equal(message.snapshot.motionPlaybackRecords[1]?.payloadKind, "speech_only");

  bridge.dispose();
}

function testRuntimeSnapshotRequiresPublisherIdentity(): void {
  const missingPublisher = { ...defaultSnapshot } as Partial<DesktopRuntimeSnapshot>;
  delete missingPublisher._publisherId;
  assert.throws(
    () => normalizeSnapshot(missingPublisher as DesktopRuntimeSnapshot),
    /runtime_snapshot_publisher_id_missing/,
  );

  const missingRevision = { ...defaultSnapshot } as Partial<DesktopRuntimeSnapshot>;
  delete missingRevision._revision;
  assert.throws(
    () => normalizeSnapshot(missingRevision as DesktopRuntimeSnapshot),
    /runtime_snapshot_revision_invalid/,
  );
}

testPublishSnapshotStripsUncloneableRuntimeValues();
testRuntimeSnapshotRequiresPublisherIdentity();
console.log("desktopBridgeClone tests passed");
