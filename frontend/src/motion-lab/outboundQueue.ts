import type { MotionLabRawEventPayload } from "../adapter-connection/outbound/outboundActions.js";
import { cloneJson } from "../utils/cloneJson.js";

export type MotionLabRawEventInput = Omit<MotionLabRawEventPayload, "event_id">;

export interface PendingMotionLabEvent {
  eventId: string;
  payload: MotionLabRawEventPayload;
  turnId: string | null;
  enqueuedAtMs?: number;
}

export interface MotionLabPendingEventStore {
  list(): Promise<PendingMotionLabEvent[]>;
  put(event: PendingMotionLabEvent): Promise<void>;
  delete(eventId: string): Promise<void>;
}

export interface MotionLabOutboundQueue {
  enqueue(payload: MotionLabRawEventInput, turnId: string | null): Promise<string>;
  acknowledgePersisted(eventId: string): Promise<boolean>;
  rejectPersisted(eventId: string, reason?: string): Promise<boolean>;
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
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = MIN_RETRY_DELAY_MS;

  const ready = options.store.list().then(async (events) => {
    for (const event of [...events].sort(comparePendingEventAge)) {
      assertPendingEvent(event);
      pending.set(event.eventId, event);
    }
    await trimPendingEvents("startup");
  });

  async function trimPendingEvents(reason: string): Promise<void> {
    while (pending.size > MAX_PENDING_MOTION_LAB_EVENTS) {
      const oldest = pending.values().next().value as PendingMotionLabEvent | undefined;
      if (!oldest) {
        return;
      }
      await options.store.delete(oldest.eventId);
      pending.delete(oldest.eventId);
      inFlight.delete(oldest.eventId);
      console.warn("[MotionLab] dropped oldest persisted outbound event.", {
        eventId: oldest.eventId,
        eventType: oldest.payload.event_type,
        reason,
        capacity: MAX_PENDING_MOTION_LAB_EVENTS,
      });
    }
  }

  const reportError = (message: string, error?: unknown): void => {
    options.onError?.(message, error);
  };

  const clearRetryTimer = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleRetry = (): void => {
    if (disposed || !connected || retryTimer !== null) {
      return;
    }
    const delay = retryDelayMs;
    retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * 2);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush().catch((error) => reportError("MotionLab queue flush failed.", error));
    }, delay);
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
          reportError(`MotionLab event send rejected; retry scheduled (event_id=${event.eventId}).`);
          scheduleRetry();
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
      retryDelayMs = MIN_RETRY_DELAY_MS;
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
        enqueuedAtMs: Date.now(),
      };
      console.info("[MotionLab] enqueueing raw event.", {
        eventType: payload.event_type,
        turnId,
        messageId: payload.message_id ?? "",
      });
      await options.store.put(event);
      pending.set(eventId, event);
      await trimPendingEvents("capacity");
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
    async rejectPersisted(eventId, reason = "backend_rejected") {
      await ready;
      const normalized = eventId.trim();
      if (!normalized || !pending.has(normalized)) {
        return false;
      }
      await options.store.delete(normalized);
      pending.delete(normalized);
      inFlight.delete(normalized);
      console.warn("[MotionLab] backend rejected outbound event; removed locally.", {
        eventId: normalized,
        reason,
      });
      void flush().catch((error) => reportError("MotionLab queue flush failed.", error));
      return true;
    },
    handleConnected() {
      if (disposed) {
        return;
      }
      connected = true;
      clearRetryTimer();
      retryDelayMs = MIN_RETRY_DELAY_MS;
      inFlight.clear();
      void flush().catch((error) => reportError("MotionLab queue flush failed.", error));
    },
    handleDisconnected() {
      connected = false;
      clearRetryTimer();
      retryDelayMs = MIN_RETRY_DELAY_MS;
      inFlight.clear();
    },
    dispose() {
      disposed = true;
      connected = false;
      clearRetryTimer();
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
      const result = await requestResult(request) as unknown[];
      await completed;
      const validEvents: PendingMotionLabEvent[] = [];
      const invalidEventIds: string[] = [];
      for (const candidate of result) {
        if (isPendingMotionLabEvent(candidate)) {
          validEvents.push(candidate);
        } else {
          const eventId = readStoredEventId(candidate);
          if (eventId) {
            invalidEventIds.push(eventId);
          }
        }
      }
      if (invalidEventIds.length > 0) {
        const cleanupTransaction = db.transaction(MOTION_LAB_OBJECT_STORE, "readwrite");
        const cleanupCompleted = transactionComplete(cleanupTransaction);
        const objectStore = cleanupTransaction.objectStore(MOTION_LAB_OBJECT_STORE);
        for (const eventId of invalidEventIds) {
          objectStore.delete(eventId);
        }
        await cleanupCompleted;
        console.warn("[MotionLab] removed invalid persisted outbound events.", {
          count: invalidEventIds.length,
        });
      }
      return validEvents;
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
const MOTION_LAB_DATABASE_VERSION = 3;
const MIN_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5000;
const MAX_PENDING_MOTION_LAB_EVENTS = 512;

function openMotionLabDatabase(): Promise<IDBDatabase> {
  if (!window.indexedDB) {
    return Promise.reject(new Error("IndexedDB is required for MotionLab delivery."));
  }
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(
      MOTION_LAB_DATABASE,
      MOTION_LAB_DATABASE_VERSION,
    );
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MOTION_LAB_OBJECT_STORE)) {
        db.createObjectStore(MOTION_LAB_OBJECT_STORE, { keyPath: "eventId" });
      } else {
        console.info("[MotionLab] preserving persisted outbound events during database upgrade.", {
          fromVersion: event.oldVersion,
          toVersion: MOTION_LAB_DATABASE_VERSION,
        });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
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
    || (event.enqueuedAtMs !== undefined
      && (typeof event.enqueuedAtMs !== "number"
        || !Number.isFinite(event.enqueuedAtMs)
        || event.enqueuedAtMs < 0))
  ) {
    throw new Error("MotionLab pending event failed storage validation.");
  }
}

function comparePendingEventAge(
  left: PendingMotionLabEvent,
  right: PendingMotionLabEvent,
): number {
  return (left.enqueuedAtMs ?? 0) - (right.enqueuedAtMs ?? 0);
}

function isPendingMotionLabEvent(value: unknown): value is PendingMotionLabEvent {
  try {
    assertPendingEvent(value);
    return true;
  } catch {
    return false;
  }
}

function readStoredEventId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const eventId = (value as { eventId?: unknown }).eventId;
  return typeof eventId === "string" && eventId.trim() ? eventId.trim() : null;
}
