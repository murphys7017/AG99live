import type { useTurnPlaybackSessionStore } from "../../turn-playback/useTurnPlaybackSessionStore.js";
import type { IncrementalIdentity } from "../../turn-playback/incrementalSegments.js";
import type { PcmTimelineStream } from "../../playback-timeline/pcmTimelinePlayback.js";
import type { IncrementalOutputEvent } from "./incrementalOutputProtocol.js";
import { identityFromAudioFrame } from "./incrementalOutputProtocol.js";
import { parseOutputAudioFrame } from "./outputAudioFrame.js";

const WINDOW_BYTES = 128 * 1024;
const WINDOW_FRAMES = 64;
const MAX_AUDIO_JOBS = WINDOW_FRAMES + 256; // Frames plus one end per legal segment.

async function waitWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}

type AudioJob = { id: IncrementalIdentity } & (
  | { kind: "chunk"; offset: number; pcm: Uint8Array }
  | { kind: "end"; length: number; status: "completed" | "failed"; reason: string }
);

/** Wire admission is synchronous. One bounded worker owns actual PCM playback. */
export function createIncrementalOutputRuntime(options: {
  getStore(): ReturnType<typeof useTurnPlaybackSessionStore>;
  currentTurnId(): string | null;
  openPcm(turnId: string, messageId: string): Promise<PcmTimelineStream>;
  displayText(text: string, turnId: string): void;
  recordText(text: string, turnId: string): void;
  sendAudioCredit(id: IncrementalIdentity, releasedBytes: number, releasedFrames: number): void;
  onAsyncError(error: unknown): void;
}) {
  let active: { turnId: string; messageId: string; handle: PcmTimelineStream } | null = null;
  let draining: Promise<void> = Promise.resolve();
  let generation = 0;
  let controller = new AbortController();
  let scope: IncrementalIdentity | null = null;
  const queue: AudioJob[] = [];
  let processing = false;
  let receivedBytes = 0;
  let receivedFrames = 0;
  let releasedBytes = 0;
  let releasedFrames = 0;

  function isLive(id: IncrementalIdentity, production = true): boolean {
    const session = options.getStore().getSession(id.turnId);
    return Boolean(options.currentTurnId() === id.turnId && session?.backend.turnStarted
      && (!production || !session.backend.synthFinished) && !session.backend.turnFinished
      && !session.interrupted && session.phase !== "completed" && session.phase !== "failed");
  }

  function requireScope(id: IncrementalIdentity): void {
    if (!scope) scope = id;
    if (scope.turnId !== id.turnId || scope.coreTurnId !== id.coreTurnId || scope.personaResultId !== id.personaResultId) {
      throw new Error("incremental_audio_scope_changed_without_retirement");
    }
  }

  function enqueue(job: AudioJob): void {
    if (queue.length >= MAX_AUDIO_JOBS) throw new Error("incremental_audio_job_capacity_exceeded");
    queue.push(job);
    if (!processing) void drain(generation, controller.signal);
  }

  async function drain(epoch: number, signal: AbortSignal): Promise<void> {
    processing = true;
    try {
      while (queue.length && epoch === generation) {
        signal.throwIfAborted();
        const job = queue.shift()!;
        if (!isLive(job.id, false)) throw new DOMException("Stale PCM stream.", "AbortError");
        if (job.kind === "chunk") {
          if (!active) {
            await waitWithAbort(draining, signal);
            signal.throwIfAborted();
            const handle = await waitWithAbort(options.openPcm(job.id.turnId, job.id.messageId), signal);
            signal.throwIfAborted();
            active = { turnId: job.id.turnId, messageId: job.id.messageId, handle };
          }
          if (active.turnId !== job.id.turnId || active.messageId !== job.id.messageId) {
            throw new Error("incremental_audio_crossed_open_segment");
          }
          await waitWithAbort(active.handle.append(job.offset, job.pcm), signal);
          signal.throwIfAborted();
          releasedBytes += job.pcm.byteLength;
          releasedFrames += 1;
          options.sendAudioCredit(job.id, releasedBytes, releasedFrames);
        } else {
          if (!active || active.turnId !== job.id.turnId || active.messageId !== job.id.messageId) {
            throw new Error("incremental_audio_end_without_playback");
          }
          const handle = active.handle;
          handle.finish(job.length, job.status, job.reason);
          draining = handle.completed.then(() => undefined, () => undefined);
          active = null;
        }
      }
    } catch (error) {
      if (epoch === generation && !signal.aborted) {
        reset();
        try { options.onAsyncError(error); }
        catch (observerError) { console.error("[IncrementalOutput] async failure cleanup failed.", observerError); }
      }
    } finally {
      if (epoch === generation) processing = false;
    }
  }

  function handleAudio(buffer: ArrayBuffer, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    const { metadata, pcm } = parseOutputAudioFrame(buffer);
    const id = identityFromAudioFrame(metadata);
    if (!isLive(id)) return;
    requireScope(id);
    if (!Number.isSafeInteger(receivedBytes + pcm.byteLength) || !Number.isSafeInteger(receivedFrames + 1)
      || receivedBytes + pcm.byteLength - releasedBytes > WINDOW_BYTES
      || receivedFrames + 1 - releasedFrames > WINDOW_FRAMES) {
      throw new Error("incremental_audio_credit_window_exceeded");
    }
    options.getStore().acceptIncrementalAudio(id, metadata.sample_offset, pcm.byteLength);
    receivedBytes += pcm.byteLength;
    receivedFrames += 1;
    enqueue({ kind: "chunk", id, offset: metadata.sample_offset, pcm });
  }

  function handleEvent(event: IncrementalOutputEvent): void {
    const { identity: id, resource } = event;
    if (!isLive(id)) return;
    requireScope(id);
    const store = options.getStore();
    if (event.kind === "start") {
      store.startIncrementalStream(resource, id);
    } else if (event.kind === "delta") {
      const text = store.appendIncrementalText(id, event.text);
      options.displayText(text, id.turnId);
    } else if (event.kind === "update") {
      store.updateIncrementalMotion(id, event.motionPayload);
    } else {
      store.endIncrementalStream(resource, id, event.status, event.reason, event.length);
      if (resource === "text") {
        const text = store.getSession(id.turnId)?.segments.get(id.messageId)?.text.content;
        if (text) options.recordText(text, id.turnId);
      } else if (resource === "audio" && event.length! > 0) {
        enqueue({ kind: "end", id, length: event.length!,
          status: event.status === "completed" ? "completed" : "failed", reason: event.reason });
      }
    }
  }

  function cancelTurn(turnId: string): void {
    if (scope?.turnId === turnId) reset();
  }
  function reset(): void {
    generation += 1;
    controller.abort();
    controller = new AbortController();
    queue.length = 0;
    active = null;
    draining = Promise.resolve();
    processing = false;
    scope = null;
    receivedBytes = receivedFrames = releasedBytes = releasedFrames = 0;
  }
  return { handleAudio, handleEvent, cancelTurn, reset };
}
