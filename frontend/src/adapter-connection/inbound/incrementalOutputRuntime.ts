import type { TurnPlaybackSessionPort } from "../../turn-playback/sessionStorePort.js";
import type { IncrementalIdentity } from "../../turn-playback/incrementalSegments.js";
import { PcmSegmentPlaybackError, type PcmTimelineStream } from "../../playback-timeline/pcmTimelinePlayback.js";
import type { IncrementalOutputEvent } from "./incrementalOutputProtocol.js";
import { identityFromAudioFrame } from "./incrementalOutputProtocol.js";
import { parseOutputAudioFrame } from "./outputAudioFrame.js";
import { reportLatencyStage } from "../runtime/latency.js";
import { decodePcmSamples } from "../../playback-timeline/pcmSamples.js";

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
  | { kind: "chunk"; offset: number; samples: Float32Array; wireBytes: number }
  | { kind: "end"; length: number; status: "completed" | "failed"; reason: string }
);

/** Wire admission is synchronous. One bounded worker owns actual PCM playback. */
export function createIncrementalOutputRuntime(options: {
  prewarmSpeechOutput(): void;
  getStore(): TurnPlaybackSessionPort;
  currentTurnId(): string | null;
  openPcm(turnId: string, messageId: string): Promise<PcmTimelineStream>;
  displayText(text: string, turnId: string, messageId: string, speaking: boolean | null): void;
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
  let textObserved = false;

  // Text production remains immediate, while visible text waits for the
  // matching segment's audio start or an explicit no-audio terminal state.
  const releasedTextMessages = new Set<string>();
  const resultCredits = new Map<string, { bytes: number; frames: number }>();

  function messageKey(id: IncrementalIdentity): string {
    return `${id.turnId}\u0000${id.messageId}`;
  }

  function releaseText(id: IncrementalIdentity, speaking: boolean | null = null): void {
    const key = messageKey(id);
    if (!isLive(id, false)) return;
    if (releasedTextMessages.has(key) && speaking !== true) return;
    releasedTextMessages.add(key);
    const text = options.getStore().getSession(id.turnId)?.segments
      .get(id.messageId)?.text.content;
    if (text) options.displayText(text, id.turnId, id.messageId, speaking);
  }

  function watchAudioStart(id: IncrementalIdentity, handle: PcmTimelineStream): void {
    const epoch = generation;
    void handle.started.then(
      () => { if (generation === epoch) releaseText(id, true); },
      () => { if (generation === epoch) releaseText(id, false); },
    );
  }

  function audioFailed(id: IncrementalIdentity): boolean {
    return options.getStore().getSession(id.turnId)?.segments.get(id.messageId)?.audio.terminal === "failed";
  }

  function markDeviceFailure(id: IncrementalIdentity, error: Error): void {
    active = null;
    options.getStore().markAudioTerminal(id.turnId, "failed", id.messageId, error.message);
    releasedTextMessages.delete(messageKey(id));
    releaseText(id, false);
  }

  function isLive(id: IncrementalIdentity, production = true): boolean {
    const session = options.getStore().getSession(id.turnId);
    return Boolean(options.currentTurnId() === id.turnId && session?.backend.turnStarted
      && (!production || !session.backend.synthFinished) && !session.backend.turnFinished
      && !session.interrupted && session.phase !== "completed" && session.phase !== "failed");
  }

  function requireScope(id: IncrementalIdentity): void {
    if (!scope) scope = id;
    if (scope.turnId !== id.turnId || scope.coreTurnId !== id.coreTurnId) {
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
        if (!isLive(job.id, false)) {
          cancelTurn(job.id.turnId);
          return;
        }
        if (job.kind === "chunk") {
          // Combine only contiguous chunks already admitted. Never wait for a future frame.
          let samples = job.samples;
          let frameCount = 1;
          let wireBytes = job.wireBytes;
          const parts = [samples];
          while (queue[0]?.kind === "chunk") {
            const next = queue[0];
            if (next.id.streamId !== job.id.streamId || next.id.messageId !== job.id.messageId
              || next.offset !== job.offset + wireBytes / 2 || wireBytes + next.wireBytes > 2048) break;
            parts.push(next.samples);
            wireBytes += next.wireBytes;
            frameCount++;
            queue.shift();
          }
          if (frameCount > 1) {
            samples = new Float32Array(wireBytes / 2);
            let cursor = 0;
            for (const part of parts) { samples.set(part, cursor); cursor += part.length; }
          }
          if (!audioFailed(job.id)) {
            try {
              if (!active) {
                await waitWithAbort(draining, signal);
                signal.throwIfAborted();
                const handle = await waitWithAbort(options.openPcm(job.id.turnId, job.id.messageId), signal);
                signal.throwIfAborted();
                watchAudioStart(job.id, handle);
                active = { turnId: job.id.turnId, messageId: job.id.messageId, handle };
              }
              if (active.turnId !== job.id.turnId || active.messageId !== job.id.messageId) {
                throw new Error("incremental_audio_crossed_open_segment");
              }
              await waitWithAbort(active.handle.append(job.offset, samples), signal);
            } catch (error) {
              if (!(error instanceof PcmSegmentPlaybackError) || signal.aborted) throw error;
              markDeviceFailure(job.id, error);
            }
          }
          signal.throwIfAborted();
          releasedBytes += wireBytes;
          releasedFrames += frameCount;
          const credit = resultCredits.get(job.id.personaResultId) ?? { bytes: 0, frames: 0 };
          credit.bytes += wireBytes;
          credit.frames += frameCount;
          resultCredits.set(job.id.personaResultId, credit);
          options.sendAudioCredit(job.id, credit.bytes, credit.frames);
        } else {
          if (audioFailed(job.id)) {
            active = null;
            continue;
          }
          if (!active || active.turnId !== job.id.turnId || active.messageId !== job.id.messageId) {
            throw new Error("incremental_audio_end_without_playback");
          }
          const handle = active.handle;
          try {
            handle.finish(job.length, job.status, job.reason);
          } catch (error) {
            if (!(error instanceof PcmSegmentPlaybackError)) throw error;
            markDeviceFailure(job.id, error);
            continue;
          }
          draining = handle.readyForNext;
          void draining.catch(() => undefined);
          active = null;
        }
      }
    } catch (error) {
      if (epoch === generation && !signal.aborted) {
        // Local interruption stops the timeline before its server echo arrives.
        // That retirement is expected, including rejection of an in-flight append.
        const retired = scope === null || !isLive(scope, false);
        reset();
        try { if (!retired) options.onAsyncError(error); }
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
    if (metadata.sample_offset === 0) {
      reportLatencyStage("incremental_pcm_first", id.turnId, id.streamId, id.messageId);
    }
    receivedBytes += pcm.byteLength;
    receivedFrames += 1;
    // Decode on admission, including the next segment while the current one
    // drains. Credits remain in wire bytes; decoded storage is bounded to 2x.
    enqueue({ kind: "chunk", id, offset: metadata.sample_offset,
      samples: decodePcmSamples(pcm), wireBytes: pcm.byteLength });
  }

  function handleEvent(event: IncrementalOutputEvent): void {
    const { identity: id, resource } = event;
    if (!isLive(id)) return;
    requireScope(id);
    const store = options.getStore();
    if (event.kind === "start") {
      store.startIncrementalStream(resource, id);
      if (resource === "audio") options.prewarmSpeechOutput();
    } else if (event.kind === "delta") {
      const text = store.appendIncrementalText(id, event.text);
      if (releasedTextMessages.has(messageKey(id))) {
        const audio = store.getSession(id.turnId)?.segments.get(id.messageId)?.audio;
        options.displayText(text, id.turnId, id.messageId,
          audio?.terminal === "idle" ? (audio.started ? true : null) : false);
      }
      if (!textObserved) {
        textObserved = true;
        reportLatencyStage("incremental_text_first", id.turnId, id.streamId, id.messageId);
      }
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
      } else if (resource === "audio") {
        releaseText(id, false);
      }
    }
  }

  function cancelTurn(turnId: string): void {
    if (scope?.turnId === turnId) reset();
  }
  function beginTurn(turnId: string): void {
    if (scope && scope.turnId !== turnId) reset();
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
    textObserved = false;
    releasedTextMessages.clear();
    resultCredits.clear();
  }
  return { handleAudio, handleEvent, beginTurn, cancelTurn, reset };
}
