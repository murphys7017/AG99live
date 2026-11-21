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
  list(): Promise<Array<Pick<PendingMotionLabEvent, "eventId" | "enqueuedAtMs">>>;
  get(eventId: string): Promise<PendingMotionLabEvent | undefined>;
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
  const pending = new Set<string>();
  const inFlight = new Map<string, { bytes: number; expiresAt: number }>();
  let ackTimer: ReturnType<typeof setTimeout> | undefined;
  let connected = false;
  let disposed = false;
  let flushing = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = MIN_RETRY_DELAY_MS;

  const ready = options.store.list().then(events => {
    events.sort((a, b) => (a.enqueuedAtMs ?? 0) - (b.enqueuedAtMs ?? 0));
    for (const event of events) pending.add(event.eventId);
  });

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
    clearTimeout(ackTimer);
    try {
      const now = Date.now();
      let outstandingBytes = 0;
      for (const [id, item] of inFlight) {
        if (item.expiresAt <= now) inFlight.delete(id);
        else outstandingBytes += item.bytes;
      }
      for (const eventId of pending) {
        if (disposed || !connected) {
          return;
        }
        if (inFlight.size >= 8) return;
        if (inFlight.has(eventId)) {
          continue;
        }
        const event = await options.store.get(eventId);
        if (!connected || disposed) return;
        if (!event || !pending.has(eventId)) {
          pending.delete(eventId);
          continue;
        }
        const bytes = new TextEncoder().encode(JSON.stringify(event.payload)).length;
        if (inFlight.size && outstandingBytes + bytes > 128 * 1024) return;
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
        inFlight.set(event.eventId, { bytes, expiresAt: now + 15_000 });
        outstandingBytes += bytes;
      }
      retryDelayMs = MIN_RETRY_DELAY_MS;
    } catch (error) {
      scheduleRetry();
      throw error;
    } finally {
      flushing = false;
      if (connected && !disposed && inFlight.size) {
        const deadline = Math.min(...Array.from(inFlight.values(), entry => entry.expiresAt));
        ackTimer = setTimeout(() => {
          void flush().catch(error => reportError("MotionLab acknowledgement retry failed.", error));
        }, Math.max(1, deadline - Date.now()));
      }
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
      pending.add(eventId);
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
      clearTimeout(ackTimer);
      inFlight.clear();
      void flush().catch((error) => reportError("MotionLab queue flush failed.", error));
    },
    handleDisconnected() {
      connected = false;
      clearRetryTimer();
      retryDelayMs = MIN_RETRY_DELAY_MS;
      clearTimeout(ackTimer);
      inFlight.clear();
    },
    dispose() {
      disposed = true;
      connected = false;
      clearRetryTimer();
      clearTimeout(ackTimer);
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
      const request = transaction.objectStore(MOTION_LAB_OBJECT_STORE).openCursor();
      const entries: Array<Pick<PendingMotionLabEvent, "eventId" | "enqueuedAtMs">> = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (isPendingMotionLabEvent(cursor.value)) {
          entries.push({ eventId: cursor.value.eventId, enqueuedAtMs: cursor.value.enqueuedAtMs });
        } else {
          console.warn("[MotionLab] skipped invalid stored event.", cursor.primaryKey);
        }
        cursor.continue();
      };
      await completed;
      return entries;
    },
    async get(eventId) {
      const db = await database;
      const tx = db.transaction(MOTION_LAB_OBJECT_STORE, "readonly");
      const value: unknown = await requestResult(tx.objectStore(MOTION_LAB_OBJECT_STORE).get(eventId));
      return isPendingMotionLabEvent(value) ? value : undefined;
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

function isPendingMotionLabEvent(value: unknown): value is PendingMotionLabEvent {
  try {
    assertPendingEvent(value);
    return true;
  } catch {
    return false;
  }
}
