import { watch, type DeepReadonly } from "vue";
import type { useTurnPlaybackSessionStore } from "./useTurnPlaybackSessionStore";
import type { NormalizedMotionPayload } from "../types/motion.js";
import { cloneJson } from "../utils/cloneJson.js";
import {
  canReleaseAudio,
  canReleaseMotion,
  getActivePlaybackSegment,
} from "./selectors.js";
import type { TurnPlaybackSegment } from "./session.js";
import type { PlaybackTimelineRuntime } from "../playback-timeline/playbackTimelineRuntime.js";

type SessionStore = ReturnType<typeof useTurnPlaybackSessionStore>;

interface TurnPlaybackOrchestratorOptions {
  sessionStore: SessionStore;
  timelineRuntime: Pick<
    PlaybackTimelineRuntime<NormalizedMotionPayload>,
    | "startSegmentJob"
    | "handoffSpeechMotionTail"
    | "startIncrementalMotion"
    | "rejectMotionBeforeStart"
    | "findPlaybackReleaseBlockers"
    | "subscribeExecutionStateChanges"
  >;
}

export function useTurnPlaybackOrchestrator(
  options: TurnPlaybackOrchestratorOptions,
) {
  function scheduleReadySegments(): void {
    for (const session of options.sessionStore.getSessions()) {
      if (session.interrupted || session.phase === "completed" || session.phase === "failed") continue;
      for (let index = 0; index + 1 < session.segmentOrder.length; index++) {
        const previous = session.segments.get(session.segmentOrder[index]!);
        const next = session.segments.get(session.segmentOrder[index + 1]!);
        if (!previous || !next || previous.incremental || next.incremental
          || previous.audio.terminal !== "completed" || !previous.text.delivered
          || !isAtomicSegmentResolved(next) || !canReleaseAudio(next)) continue;
        if (previous.motion.pending) {
          // A generated result is still acknowledged later, but can no longer
          // animate this completed speech window or hold up the following audio.
          options.sessionStore.markMotionFailed(previous.turnId, previous.messageId, "deferred_motion_speech_window_ended");
        }
        options.timelineRuntime.handoffSpeechMotionTail(previous.turnId, previous.messageId);
      }
    }
    // Motion follows segment order independently of text/PCM production.
    // An unfinished earlier action must not overwrite a later action on arrival.
    for (const session of options.sessionStore.getSessions()) {
      if (session.interrupted || session.phase === "completed" || session.phase === "failed") continue;
      for (const segmentId of session.segmentOrder) {
        const segment = session.segments.get(segmentId);
        if (!segment?.incremental) continue;
        if (segment.motion.failed || segment.motion.completed || segment.motion.absent) continue;
        if (segment.motion.payload && !segment.motion.released
          && segment.audio.terminal === "failed") {
          options.timelineRuntime.rejectMotionBeforeStart(
            segment.turnId, segment.messageId,
            `audio_failed_before_motion_release:${segment.audio.reason || "audio_failed"}`,
          );
          continue;
        }
        if (segment.audio.started && segment.audio.terminal === "idle"
          && segment.motion.payload && !segment.motion.released
          && segment.motion.receivedAtMs !== null) {
          options.timelineRuntime.startIncrementalMotion({
            turnId: segment.turnId, messageId: segment.messageId,
            payload: cloneReleasedMotionPayload(segment.motion.payload),
            source: segment.motion.source, receivedAtMs: segment.motion.receivedAtMs,
            assistantText: segment.text.content ?? "", speechCues: segment.speech.cues,
          });
        }
        // Pending motion retains its place, but never blocks the PCM consumer.
        break;
      }
    }
    let segment: DeepReadonly<TurnPlaybackSegment> | null = null;
    for (const session of options.sessionStore.getSessions()) {
      if (session.interrupted || session.phase === "completed" || session.phase === "failed") {
        continue;
      }
      segment = getActivePlaybackSegment(session);
      if (segment) {
        break;
      }
      if (!session.backend.synthFinished) {
        console.debug("[TurnPlaybackOrchestrator] waiting for synth_finished before releasing segment.", {
          turnId: session.turnId,
          phase: session.phase,
        });
        return;
      }
    }
    const blockers = options.timelineRuntime.findPlaybackReleaseBlockers().filter((blocker) => !(
      segment?.incremental
      && segment.audio.terminal === "completed"
      && segment.motion.payload
      && !segment.motion.released
      && blocker.turnId === segment.turnId
      && blocker.messageId === segment.messageId
    ));
    if (blockers.length > 0) {
      console.debug("[TurnPlaybackOrchestrator] playback release blocked by active timeline.", { blockers });
      return;
    }
    // Text/PCM remain owned by the stream consumer. Once audio is absent or
    // complete, a valid action gets its own motion timeline without audio replay.
    if (segment?.incremental) {
      if (
        segment.motion.payload
        && !segment.motion.released
        && !segment.motion.failed
        && !segment.motion.completed
        && (segment.audio.terminal === "absent" || segment.audio.terminal === "completed")
        && segment.motion.receivedAtMs !== null
      ) {
        options.timelineRuntime.startSegmentJob({
          turnId: segment.turnId,
          messageId: segment.messageId,
          reason: segment.audio.terminal === "completed"
            ? "incremental_motion_after_audio"
            : "incremental_motion_without_audio",
          text: { release: false, content: segment.text.content },
          audio: { release: false, url: null, noAudioConfirmed: true },
          motion: {
            payload: cloneReleasedMotionPayload(segment.motion.payload),
            source: segment.motion.source, receivedAtMs: segment.motion.receivedAtMs,
          },
          speech: { cues: segment.speech.cues },
        });
      }
      return;
    }
    if (!segment || !isAtomicSegmentResolved(segment)) {
      if (segment) {
        console.debug("[TurnPlaybackOrchestrator] candidate segment is not atomically resolved.", {
          turnId: segment.turnId,
          messageId: segment.messageId,
          text: {
            contentPresent: Boolean(segment.text.content),
            released: segment.text.released,
            delivered: segment.text.delivered,
          },
          audio: {
            urlPresent: Boolean(segment.audio.url),
            released: segment.audio.released,
            terminal: segment.audio.terminal,
          },
          motion: {
            payloadPresent: segment.motion.payload !== null,
            released: segment.motion.released,
            started: segment.motion.started,
            completed: segment.motion.completed,
            absent: segment.motion.absent,
            failed: segment.motion.failed,
          },
        });
      }
      return;
    }
    const session = options.sessionStore.getSession(segment.turnId);
    if (session?.phase === "collecting") {
      options.sessionStore.markPhase(segment.turnId, "ready");
    }

    if (
      segment.audio.terminal === "failed"
      && segment.motion.payload
      && !segment.motion.failed
      && !segment.motion.released
    ) {
      options.timelineRuntime.rejectMotionBeforeStart(
        segment.turnId,
        segment.messageId,
        `audio_failed_before_motion_release:${segment.audio.reason || "audio_failed"}`,
      );
    }

    const textOwnedByReleasedAudioTimeline = Boolean(segment.audio.url)
      && segment.audio.released
      && segment.audio.terminal === "idle";
    const releaseText = Boolean(segment.text.content)
      && !segment.text.released
      && !textOwnedByReleasedAudioTimeline;
    const releaseAudio = canReleaseAudio(segment);
    const releaseMotion = canReleaseMotion(segment)
      && segment.motion.payload !== null
      && segment.audio.terminal !== "failed";
    if (!releaseText && !releaseAudio && !releaseMotion) {
      console.debug("[TurnPlaybackOrchestrator] resolved segment has no newly releasable material.", {
        turnId: segment.turnId,
        messageId: segment.messageId,
        textReleased: segment.text.released,
        audioReleased: segment.audio.released,
        motionReleased: segment.motion.released,
      });
      return;
    }
    const motionPayload = releaseMotion && segment.motion.payload
      ? cloneReleasedMotionPayload(segment.motion.payload)
      : null;
    const receivedAtMs = releaseMotion ? segment.motion.receivedAtMs : null;
    if (
      releaseMotion
      && (
        receivedAtMs === null
        || !Number.isFinite(receivedAtMs)
        || receivedAtMs < 0
      )
    ) {
      options.timelineRuntime.rejectMotionBeforeStart(
        segment.turnId,
        segment.messageId,
        "motion_received_at_missing",
      );
      return;
    }

    console.info("[TurnPlaybackOrchestrator] releasing atomic segment to playback timeline.", {
      turnId: segment.turnId,
      messageId: segment.messageId,
      releaseText,
      releaseAudio,
      releaseMotion,
      timelineMode: segment.audio.terminal === "absent" && !releaseAudio
        ? "motion_only"
        : "audio",
      audioTerminal: segment.audio.terminal,
      motionPayloadKind: motionPayload?.kind ?? null,
    });
    options.timelineRuntime.startSegmentJob({
      turnId: segment.turnId,
      messageId: segment.messageId,
      reason: "atomic_output_segment_ready",
      text: {
        release: releaseText,
        content: segment.text.content,
      },
      audio: {
        release: releaseAudio,
        url: segment.audio.url,
        noAudioConfirmed: segment.audio.terminal === "absent",
      },
      motion: {
        payload: motionPayload,
        source: releaseMotion ? segment.motion.source : null,
        receivedAtMs,
      },
      speech: {
        cues: segment.speech.cues,
      },
    });
  }

  // Segments are committed atomically; only readiness and lifecycle replacements matter here.
  const stopSessionWatch = watch(
    () => options.sessionStore.getSessions().map((session) => ({
      id: session.id,
      phase: session.phase,
      backendSynthFinished: session.backend.synthFinished,
      segments: session.segmentOrder.map((messageId) => {
        const segment = session.segments.get(messageId);
        return segment ? {
          messageId,
          textContent: segment.text.content,
          textReleased: segment.text.released,
          textDelivered: segment.text.delivered,
          audioUrl: segment.audio.url,
          audioReleased: segment.audio.released,
          audioStarted: segment.audio.started,
          audioTerminal: segment.audio.terminal,
          motionPayloadPresent: segment.motion.payload !== null,
          motionReleased: segment.motion.released,
          motionAbsent: segment.motion.absent,
          motionFailed: segment.motion.failed,
          motionCompleted: segment.motion.completed,
          speechCueCount: segment.speech.cues.length,
        } : null;
      }),
    })),
    scheduleReadySegments,
    { immediate: true },
  );
  const unsubscribeExecutionStateChanges =
    options.timelineRuntime.subscribeExecutionStateChanges(scheduleReadySegments);

  return {
    flush: scheduleReadySegments,
    dispose() {
      stopSessionWatch();
      unsubscribeExecutionStateChanges();
    },
  };
}

function isAtomicSegmentResolved(
  segment: DeepReadonly<TurnPlaybackSegment>,
): boolean {
  const textResolved = Boolean(segment.text.content) || segment.text.delivered;
  const audioResolved = Boolean(segment.audio.url) || segment.audio.terminal !== "idle";
  const motionResolved = Boolean(segment.motion.payload)
    || segment.motion.pending
    || segment.motion.absent
    || segment.motion.failed;
  return textResolved && audioResolved && motionResolved;
}

function cloneReleasedMotionPayload(
  payload: DeepReadonly<NormalizedMotionPayload>,
): NormalizedMotionPayload {
  return cloneJson(payload) as unknown as NormalizedMotionPayload;
}
