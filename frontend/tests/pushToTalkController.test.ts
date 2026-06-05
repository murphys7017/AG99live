import assert from "node:assert/strict";
import { usePushToTalkController } from "../src/app/usePushToTalkController.js";
import type {
  DesktopPttAckStatus,
  DesktopPttEventAck,
  DesktopPttEventPayload,
  DesktopPttKeyBinding,
} from "../src/types/desktop.js";

type IpcHandler = (payload: DesktopPttEventPayload) => void;

interface FakeEventTarget {
  addEventListener: () => void;
  removeEventListener: () => void;
}

const defaultBinding: DesktopPttKeyBinding = {
  code: "ControlLeft",
  label: "Left Ctrl",
  uiohookKeycode: 29,
};

const fakeEventTarget: FakeEventTarget = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

function createPayload(kind: DesktopPttEventPayload["kind"]): DesktopPttEventPayload {
  return {
    eventId: `event:${kind}`,
    kind,
    keycode: 29,
    createdAt: new Date().toISOString(),
  };
}

function createHarness(options: {
  pttModeEnabled?: boolean;
  startResult?: DesktopPttAckStatus;
  stopResult?: DesktopPttAckStatus;
} = {}) {
  const handlers = new Map<string, IpcHandler>();
  const acks: DesktopPttEventAck[] = [];
  let startCalls = 0;
  let stopCalls = 0;
  const state = {
    pttModeEnabled: options.pttModeEnabled ?? true,
    pttKeyBinding: defaultBinding,
  };

  (globalThis as Record<string, unknown>).document = fakeEventTarget;
  (globalThis as Record<string, unknown>).window = {
    ...fakeEventTarget,
    ag99desktop: {
      onIpc: (channel: string, callback: IpcHandler) => {
        handlers.set(channel, callback);
        return () => {
          handlers.delete(channel);
        };
      },
      reportPttEventAck: (ack: DesktopPttEventAck) => {
        acks.push(ack);
      },
    },
  };

  const controller = usePushToTalkController({
    state,
    startPttCapture: async () => {
      startCalls += 1;
      return options.startResult ?? "started";
    },
    stopPttCapture: async () => {
      stopCalls += 1;
      return options.stopResult ?? "stopped";
    },
  });

  return {
    acks,
    controller,
    emit: (channel: string, payload: DesktopPttEventPayload) => {
      handlers.get(channel)?.(payload);
    },
    getStartCalls: () => startCalls,
    getStopCalls: () => stopCalls,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function testIpcKeydownReportsStarted(): Promise<void> {
  const harness = createHarness({ startResult: "started" });
  harness.controller.install();

  harness.emit("desktop:ptt-keydown", createPayload("keydown"));
  await flushMicrotasks();

  assert.equal(harness.getStartCalls(), 1);
  assert.deepEqual(
    harness.acks.map((ack) => ack.status),
    ["received", "started"],
  );
}

async function testIpcKeyupReportsDiscardedShortPress(): Promise<void> {
  const harness = createHarness({ stopResult: "discarded" });
  harness.controller.install();

  harness.emit("desktop:ptt-keyup", createPayload("keyup"));
  await flushMicrotasks();

  assert.equal(harness.getStopCalls(), 1);
  assert.deepEqual(
    harness.acks.map((ack) => ack.status),
    ["received", "discarded"],
  );
}

async function testDisabledPttReportsIgnored(): Promise<void> {
  const harness = createHarness({ pttModeEnabled: false });
  harness.controller.install();

  harness.emit("desktop:ptt-keydown", createPayload("keydown"));
  await flushMicrotasks();

  assert.equal(harness.getStartCalls(), 0);
  assert.deepEqual(
    harness.acks.map((ack) => ack.status),
    ["ignored"],
  );
}

async function testMalformedPayloadIsIgnored(): Promise<void> {
  const harness = createHarness();
  harness.controller.install();

  harness.emit("desktop:ptt-keydown", { ...createPayload("keyup"), eventId: "wrong-kind" });
  await flushMicrotasks();

  assert.equal(harness.getStartCalls(), 0);
  assert.equal(harness.acks.length, 0);
}

await testIpcKeydownReportsStarted();
await testIpcKeyupReportsDiscardedShortPress();
await testDisabledPttReportsIgnored();
await testMalformedPayloadIsIgnored();

console.info("pushToTalkController tests passed.");
