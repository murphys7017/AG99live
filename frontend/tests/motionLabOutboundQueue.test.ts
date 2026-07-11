import assert from "node:assert/strict";
import {
  createMotionLabOutboundQueue,
  type MotionLabPendingEventStore,
  type PendingMotionLabEvent,
} from "../src/motion-lab/outboundQueue.js";

class MemoryStore implements MotionLabPendingEventStore {
  readonly events = new Map<string, PendingMotionLabEvent>();
  readonly operations: string[] = [];
  failPut = false;

  async list(): Promise<PendingMotionLabEvent[]> {
    return [...this.events.values()];
  }

  async put(event: PendingMotionLabEvent): Promise<void> {
    this.operations.push(`put:${event.eventId}`);
    if (this.failPut) {
      throw new Error("indexeddb_write_failed");
    }
    this.events.set(event.eventId, event);
  }

  async delete(eventId: string): Promise<void> {
    this.operations.push(`delete:${eventId}`);
    this.events.delete(eventId);
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function testPersistsBeforeSendAndWaitsForAck(): Promise<void> {
  const store = new MemoryStore();
  const sends: string[] = [];
  const queue = createMotionLabOutboundQueue({
    store,
    createEventId: () => "event-1",
    send: (payload) => {
      sends.push(payload.event_id);
      assert.deepEqual(store.operations, ["put:event-1"]);
      return true;
    },
  });

  queue.handleConnected();
  const eventId = await queue.enqueue({
    event_type: "motion.playback_started",
    raw: { runId: "run-1" },
  }, "turn-1");
  await flush();

  assert.equal(eventId, "event-1");
  assert.deepEqual(sends, ["event-1"]);
  assert.equal(store.events.has("event-1"), true);
  assert.equal(queue.getPendingCount(), 1);

  assert.equal(await queue.acknowledgePersisted("event-1"), true);
  assert.equal(store.events.has("event-1"), false);
  assert.equal(queue.getPendingCount(), 0);
  assert.deepEqual(store.operations, ["put:event-1", "delete:event-1"]);
}

async function testReconnectResendsStableEventIdentity(): Promise<void> {
  const store = new MemoryStore();
  const sends: string[] = [];
  const queue = createMotionLabOutboundQueue({
    store,
    createEventId: () => "event-retry",
    send: (payload) => {
      sends.push(payload.event_id);
      return true;
    },
  });

  queue.handleConnected();
  await queue.enqueue({ event_type: "motion.completed", raw: {} }, "turn-2");
  await flush();
  queue.handleDisconnected();
  queue.handleConnected();
  await flush();

  assert.deepEqual(sends, ["event-retry", "event-retry"]);
  assert.equal(store.events.has("event-retry"), true);
  assert.equal(await queue.acknowledgePersisted("unknown-event"), false);
  assert.equal(store.events.has("event-retry"), true);
}

async function testStoreFailurePreventsSend(): Promise<void> {
  const store = new MemoryStore();
  store.failPut = true;
  let sendCount = 0;
  const queue = createMotionLabOutboundQueue({
    store,
    createEventId: () => "event-failed",
    send: () => {
      sendCount += 1;
      return true;
    },
  });

  queue.handleConnected();
  await assert.rejects(
    queue.enqueue({ event_type: "motion.failed", raw: {} }, null),
    /indexeddb_write_failed/,
  );
  await flush();

  assert.equal(sendCount, 0);
  assert.equal(queue.getPendingCount(), 0);
}

async function testSendRejectionIsVisibleAndRetained(): Promise<void> {
  const store = new MemoryStore();
  const errors: string[] = [];
  const queue = createMotionLabOutboundQueue({
    store,
    createEventId: () => "event-rejected",
    send: () => false,
    onError: (message) => errors.push(message),
  });

  queue.handleConnected();
  await queue.enqueue({ event_type: "motion.failed", raw: {} }, "turn-3");
  await flush();

  assert.equal(store.events.has("event-rejected"), true);
  assert.equal(queue.getPendingCount(), 1);
  assert.deepEqual(errors, [
    "MotionLab event send rejected; retained for reconnect (event_id=event-rejected).",
  ]);
}

async function run(): Promise<void> {
  await testPersistsBeforeSendAndWaitsForAck();
  await testReconnectResendsStableEventIdentity();
  await testStoreFailurePreventsSend();
  await testSendRejectionIsVisibleAndRetained();
  console.log("motionLabOutboundQueue tests passed");
}

await run();
