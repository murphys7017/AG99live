// Node.js test environment polyfill
(globalThis as Record<string, unknown>).window = globalThis;

import assert from "node:assert/strict";
import { createDesktopBridge } from "../src/desktop-bridge/useDesktopBridge.js";
import { defaultSnapshot } from "../src/desktop-bridge/snapshot/runtimeSnapshot.js";
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

  bridge.dispose();
}

testPublishSnapshotStripsUncloneableRuntimeValues();
console.log("desktopBridgeClone tests passed");
