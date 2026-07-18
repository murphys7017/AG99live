import type { MotionLabRawEventPayload } from "../adapter-connection/outbound/outboundActions.js";
import { cloneJson } from "../utils/cloneJson.js";

export type MotionLabRawEventInput = Omit<MotionLabRawEventPayload, "event_id">;

export interface PendingMotionLabEvent {
  eventId: string;
  payload: MotionLabRawEventPayload;
  turnId: string | null;
}

export interface MotionLabPendingEventStore {
  list(): Promise<PendingMotionLabEvent[]>;
  put(event: PendingMotionLabEvent): Promise<void>;
  delete(eventId: string): Promise<void>;
}

export interface MotionLabOutboundQueue {
  enqueue(payload: MotionLabRawEventInput, turnId: string | null): Promise<string>;
  acknowledgePersisted(eventId: string): Promise<boolean>;
  handleConnected(): void;
  handleDisconnected(): void;
  dispose(): void;
  getPendingCount(): number;
}

export function createMotionLabOutboundQueue(options: {
  store: MotionLabPendingEventStore;
  send: (payload: MotionLabRawEventPayload, turnId: string | null) => boolean;
  createEventId?: () => string;
  onError?: (message: string, error?: unknown) => void;
}): MotionLabOutboundQueue {
  const pending = new Map<string, PendingMotionLabEvent>();
  const inFlight = new Set<string>();
  let connected = false;
  let disposed = false;
  let flushing = false;

  const ready = options.store.list().then((events) => {
    for (const event of events) {
      assertPendingEvent(event);
      pending.set(event.eventId, event);
    }
  });

  const reportError = (message: string, error?: unknown): void => {
    options.onError?.(message, error);
  };

  async function flush(): Promise<void> {
    await ready;
    if (disposed || !connected || flushing) {
      return;
    }
    flushing = true;
    try {
      for (const event of pending.values()) {
        if (disposed || !connected) {
          return;
        }
        if (inFlight.has(event.eventId)) {
          continue;
        }
        if (!options.send(event.payload, event.turnId)) {
          reportError(`MotionLab event send rejected; retained for reconnect (event_id=${event.eventId}).`);
          return;
        }
        console.info("[MotionLab] raw event sent to adapter.", {
          eventId: event.eventId,
          eventType: event.payload.event_type,
          turnId: event.turnId,
          messageId: event.payload.message_id ?? "",
        });
        inFlight.add(event.eventId);
      }
    } finally {
      flushing = false;
    }
  }

  return {
    async enqueue(payload, turnId) {
      await ready;
      if (disposed) {
        throw new Error("MotionLab outbound queue is disposed.");
      }
      const eventId = (options.createEventId ?? createMotionLabEventId)();
      const event: PendingMotionLabEvent = {
        eventId,
        payload: {
          ...cloneJson(payload),
          event_id: eventId,
        },
        turnId,
      };
      console.info("[MotionLab] enqueueing raw event.", {
        eventType: payload.event_type,
        turnId,
        messageId: payload.message_id ?? "",
      });
      await options.store.put(event);
      pending.set(eventId, event);
      console.info("[MotionLab] raw event persisted locally.", {
        eventId,
        eventType: payload.event_type,
        turnId,
        messageId: payload.message_id ?? "",
      });
      void flush().catch((error) => reportError("MotionLab queue flush failed.", error));
      return eventId;
    },
    async acknowledgePersisted(eventId) {
      await ready;
      const normalized = eventId.trim();
      if (!normalized || !pending.has(normalized)) {
        return false;
      }
      await options.store.delete(normalized);
      pending.delete(normalized);
      inFlight.delete(normalized);
      void flush().catch((error) => reportError("MotionLab queue flush failed.", error));
      return true;
    },
    handleConnected() {
      if (disposed) {
        return;
      }
      connected = true;
      inFlight.clear();
      void flush().catch((error) => reportError("MotionLab queue flush failed.", error));
    },
    handleDisconnected() {
      connected = false;
      inFlight.clear();
    },
    dispose() {
      disposed = true;
      connected = false;
      inFlight.clear();
    },
    getPendingCount() {
      return pending.size;
    },
  };
}

export function createIndexedDbMotionLabPendingEventStore(): MotionLabPendingEventStore {
  const database = openMotionLabDatabase();

  return {
    async list() {
      const db = await database;
      const transaction = db.transaction(MOTION_LAB_OBJECT_STORE, "readonly");
      const completed = transactionComplete(transaction);
      const request = transaction.objectStore(MOTION_LAB_OBJECT_STORE).getAll();
      const result = await requestResult(request);
      await completed;
      return result as PendingMotionLabEvent[];
    },
    async put(event) {
      const db = await database;
      const transaction = db.transaction(MOTION_LAB_OBJECT_STORE, "readwrite");
      const completed = transactionComplete(transaction);
      transaction.objectStore(MOTION_LAB_OBJECT_STORE).put(event);
      await completed;
    },
    async delete(eventId) {
      const db = await database;
      const transaction = db.transaction(MOTION_LAB_OBJECT_STORE, "readwrite");
      const completed = transactionComplete(transaction);
      transaction.objectStore(MOTION_LAB_OBJECT_STORE).delete(eventId);
      await completed;
    },
  };
}

const MOTION_LAB_DATABASE = "ag99live-motion-lab-outbound-v1";
const MOTION_LAB_OBJECT_STORE = "pending-events";

function openMotionLabDatabase(): Promise<IDBDatabase> {
  if (!window.indexedDB) {
    return Promise.reject(new Error("IndexedDB is required for MotionLab delivery."));
  }
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(MOTION_LAB_DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MOTION_LAB_OBJECT_STORE)) {
        db.createObjectStore(MOTION_LAB_OBJECT_STORE, { keyPath: "eventId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("MotionLab IndexedDB open failed."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("MotionLab IndexedDB request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error("MotionLab IndexedDB transaction aborted."),
    );
    transaction.onerror = () => reject(
      transaction.error ?? new Error("MotionLab IndexedDB transaction failed."),
    );
  });
}

function createMotionLabEventId(): string {
  if (typeof window.crypto?.randomUUID !== "function") {
    throw new Error("crypto.randomUUID is required for MotionLab event identity.");
  }
  return `motion-lab-${window.crypto.randomUUID()}`;
}

function assertPendingEvent(value: unknown): asserts value is PendingMotionLabEvent {
  if (!value || typeof value !== "object") {
    throw new Error("MotionLab pending event is not an object.");
  }
  const event = value as Partial<PendingMotionLabEvent>;
  if (
    typeof event.eventId !== "string"
    || !event.eventId.trim()
    || !event.payload
    || event.payload.event_id !== event.eventId
    || typeof event.payload.event_type !== "string"
    || !event.payload.event_type.trim()
    || !event.payload.raw
    || typeof event.payload.raw !== "object"
    || Array.isArray(event.payload.raw)
    || (event.turnId !== null && typeof event.turnId !== "string")
  ) {
    throw new Error("MotionLab pending event failed storage validation.");
  }
}
