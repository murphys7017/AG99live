import type { useTurnPlaybackSessionStore } from "../../turn-playback/useTurnPlaybackSessionStore.js";
import type { IncrementalIdentity } from "../../turn-playback/incrementalSegments.js";
import type { PcmTimelineStream } from "../../playback-timeline/pcmTimelinePlayback.js";
import type { IncrementalOutputEvent } from "./incrementalOutputProtocol.js";
import { identityFromAudioFrame } from "./incrementalOutputProtocol.js";
import { parseOutputAudioFrame } from "./outputAudioFrame.js";

async function waitWithAbort(work: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) return work;
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Transient playback handles only; durable stream/segment state lives in SessionStore. */
export function createIncrementalOutputRuntime(options: {
  getStore(): ReturnType<typeof useTurnPlaybackSessionStore>;
  currentTurnId(): string | null;
  openPcm(turnId: string, messageId: string): Promise<PcmTimelineStream>;
  displayText(text: string, turnId: string): void;
  recordText(text: string, turnId: string): void;
}) {
  let active: { turnId: string; messageId: string; handle: PcmTimelineStream } | null = null;
  let draining: Promise<void> = Promise.resolve();
  let generation = 0;

  function isLive(id: IncrementalIdentity): boolean {
    const session = options.getStore().getSession(id.turnId);
    const live = options.currentTurnId() === id.turnId && session?.backend.turnStarted
      && !session.backend.synthFinished && !session.backend.turnFinished && !session.interrupted
      && session.phase !== "completed" && session.phase !== "failed";
    if (!live) console.info("[IncrementalOutput] stale/terminal stream event rejected.", {
      turnId: id.turnId, messageId: id.messageId, streamId: id.streamId, seq: id.seq,
    });
    return Boolean(live);
  }

  async function handleAudio(buffer: ArrayBuffer, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const { metadata, pcm } = parseOutputAudioFrame(buffer);
    const id = identityFromAudioFrame(metadata);
    if (!isLive(id)) return;
    const epoch = generation;
    const store = options.getStore();
    if (active && (active.turnId !== id.turnId || active.messageId !== id.messageId)) {
      throw new Error("incremental_audio_crossed_open_segment");
    }
    // Claim sequence/offset before scheduling. A playback failure keeps this
    // accepted prefix and fails the Turn; it must never trigger a resend.
    store.acceptIncrementalAudio(id, metadata.sample_offset, pcm.byteLength);
    if (!active) {
      await waitWithAbort(draining, signal);
      signal?.throwIfAborted();
      if (epoch !== generation || !isLive(id)) throw new DOMException("Stale PCM stream.", "AbortError");
      const handle = await options.openPcm(id.turnId, id.messageId);
      signal?.throwIfAborted();
      if (epoch !== generation || !isLive(id)) throw new DOMException("Stale PCM stream.", "AbortError");
      active = { turnId: id.turnId, messageId: id.messageId, handle };
    }
    await active.handle.append(metadata.sample_offset, pcm);
    signal?.throwIfAborted();
  }

  function handleEvent(event: IncrementalOutputEvent): void {
    const { identity: id, resource } = event;
    if (!isLive(id)) return;
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
      } else if (resource === "audio" && active?.turnId === id.turnId && active.messageId === id.messageId) {
        const handle = active.handle;
        handle.finish(event.length!, event.status === "completed" ? "completed" : "failed", event.reason);
        // Preserve failures in the authoritative segment/timeline. Ordering only
        // waits for drain; an earlier failed clip must not replay or block later text.
        draining = handle.completed.then(() => undefined, () => undefined);
        active = null;
      }
    }
  }

  function cancelTurn(turnId: string): void {
    if (active?.turnId === turnId) {
      draining = active.handle.completed.then(() => undefined, () => undefined);
      active = null;
    }
  }
  function reset(): void {
    generation += 1;
    active = null;
    draining = Promise.resolve();
  }
  return { handleAudio, handleEvent, cancelTurn, reset };
}
