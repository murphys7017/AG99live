import { ref, shallowReadonly } from "vue";
import type { ModelEnginePlanStartedEvent } from "../model-engine/runtime/contracts.js";
import type { DirectParameterPlanTerminalEvent } from "../types/live2d-runtime.d.ts";
import type { DesktopMotionPlaybackRecord } from "../types/desktop.js";
import type { MotionPlaybackRecordPort } from "../turn-playback/ports.js";
import type { PlaybackTimelineSnapshot } from "../playback-timeline/contracts.js";
import { cloneJson } from "../utils/cloneJson.js";

const DEFAULT_MAX_MOTION_PLAYBACK_RECORDS = 5;
const MOTION_RECORD_DEDUP_WINDOW_MS = 1200;

export interface MotionPlaybackRecorderOptions {
  motionRecord: MotionPlaybackRecordPort;
  initialMotionPlaybackRecords?: readonly DesktopMotionPlaybackRecord[];
  maxMotionPlaybackRecords?: number;
  getCanonicalAssistantText: (
    turnId: string | null,
    messageId: string,
  ) => string;
  getPlaybackTimelineSnapshot?: (
    turnId: string | null,
    messageId: string,
  ) => PlaybackTimelineSnapshot | null;
  onMotionLabRawEvent: (
    payload: {
      event_type: string;
      message_id?: string;
      source_route?: string;
      phase?: string;
      model_name?: string;
      profile_id?: string;
      profile_revision?: number;
      assistant_text?: string;
      payload_kind?: string;
      raw: Record<string, unknown>;
    },
    turnId?: string | null,
  ) => void;
}

export function useMotionPlaybackRecorder(options: MotionPlaybackRecorderOptions) {
  const motionPlaybackRecords = ref<DesktopMotionPlaybackRecord[]>(
    (options.initialMotionPlaybackRecords ?? []).map((record) =>
      cloneJson(record) as DesktopMotionPlaybackRecord),
  );
  const maxMotionPlaybackRecords =
    options.maxMotionPlaybackRecords ?? DEFAULT_MAX_MOTION_PLAYBACK_RECORDS;
  let currentMotionRun: {
    runId: string;
    turnId: string | null;
    messageId: string;
    playbackOrigin: ModelEnginePlanStartedEvent["playbackOrigin"];
    profileId: string;
    profileRevision?: number;
    transformTrace: Record<string, unknown> | null;
  } | null = null;

  function recordMotionPlayback(event: ModelEnginePlanStartedEvent): void {
    console.info("[MotionLab] playback plan started.", {
      playbackOrigin: event.playbackOrigin,
      startReason: event.startReason,
      turnId: event.turnId,
      playbackTurnId: event.playbackTurnId,
      messageId: event.messageId,
      runId: event.runId,
      payloadKind: event.payloadKind,
      executionKind: event.executionKind,
    });
    if (event.playbackOrigin === "manual_preview" || event.payloadKind === "compiled_semantic_motion") {
      console.info("[MotionLab] manual preview excluded from conversation history.", {
        messageId: event.messageId,
        runId: event.runId,
      });
      return;
    }

    currentMotionRun = {
      runId: event.runId,
      turnId: event.turnId,
      messageId: event.messageId,
      playbackOrigin: event.playbackOrigin,
      profileId: resolveEventProfileId(event),
      profileRevision: resolveEventProfileRevision(event),
      transformTrace: event.diagnostics?.transformTrace
        ? cloneJson(event.diagnostics.transformTrace) as unknown as Record<string, unknown>
        : null,
    };

    const now = new Date();
    const baseRecord = {
      id: `motion-record-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now.toISOString(),
      source: event.diagnostics?.source || event.startReason,
      payloadKind: event.payloadKind,
      messageId: event.messageId,
      turnId: event.turnId,
      playbackTurnId: event.playbackTurnId,
      modelName: event.model?.name ?? options.motionRecord.getSelectedModel().value?.name ?? "",
      startReason: event.startReason,
      queuedDelayMs: event.queuedDelayMs,
      assistantText: options.getCanonicalAssistantText(
        event.turnId,
        event.messageId,
      ),
      playerMessage: event.playerMessage,
      diagnostics: event.diagnostics
        ? {
            ...event.diagnostics,
          }
        : null,
    };
    const record: DesktopMotionPlaybackRecord = event.executionKind === "motion_resource"
      ? {
          ...baseRecord,
          payloadKind: "semantic_motion_resource",
          emotionLabel: event.motion.emotion_label || event.motion.label || event.motion.motion_id,
          mode: event.intent.mode,
          motion: cloneJson(event.motion),
        }
      : {
          ...baseRecord,
          payloadKind: event.payloadKind,
          emotionLabel: event.plan.emotion_label,
          mode: event.plan.mode,
          plan: cloneJson(event.plan),
          semanticMotion: cloneJson(event.semanticMotion),
        };

    const startedPayload = {
      event_type: "motion.playback_started",
      message_id: event.messageId,
      source_route: event.startReason,
      phase: "playback_started",
      model_name: event.model?.name ?? "",
      profile_id: resolveEventProfileId(event),
      profile_revision: resolveEventProfileRevision(event),
      assistant_text: record.assistantText,
      payload_kind: event.payloadKind,
      raw: {
        playbackOrigin: event.playbackOrigin,
        record,
        intent: event.payloadKind === "semantic_intent" ? cloneJson(event.intent) : null,
        speechOnlyRequest: event.payloadKind === "speech_only" ? cloneJson(event.request) : null,
        plan: event.executionKind === "parameter_plan" ? cloneJson(event.plan) : null,
        semanticMotion: event.executionKind === "parameter_plan"
          ? cloneJson(event.semanticMotion)
          : null,
        motion: event.executionKind === "parameter_plan" ? null : cloneJson(event.motion),
        diagnostics: event.diagnostics ? cloneJson(event.diagnostics) : null,
        playerMessage: event.playerMessage,
        runId: event.runId,
        queuedDelayMs: event.queuedDelayMs,
      },
    };
    options.onMotionLabRawEvent(startedPayload, event.turnId);
    if (event.executionKind === "parameter_plan" && (
      event.payloadKind === "semantic_intent" || event.payloadKind === "speech_only"
    )) {
      options.onMotionLabRawEvent({
        ...startedPayload,
        event_type: "motion.frontend_compiled",
        phase: "frontend_compiled",
        raw: {
          ...startedPayload.raw,
          playbackOrigin: event.playbackOrigin,
          intent: event.payloadKind === "semantic_intent" ? cloneJson(event.intent) : null,
          speechOnlyRequest: event.payloadKind === "speech_only"
            ? cloneJson(event.request)
            : null,
          plan: cloneJson(event.plan),
        },
      }, event.turnId);
    }

    if (isDuplicateMotionPlaybackRecord(record, motionPlaybackRecords.value[0])) {
      motionPlaybackRecords.value = [record, ...motionPlaybackRecords.value.slice(1)];
      return;
    }
    motionPlaybackRecords.value = [record, ...motionPlaybackRecords.value]
      .slice(0, maxMotionPlaybackRecords);
  }

  function completeMotionPlayback(event: DirectParameterPlanTerminalEvent): void {
    if (!currentMotionRun || currentMotionRun.runId !== event.runId) {
      return;
    }
    const run = currentMotionRun;
    currentMotionRun = null;
    const timeline = options.getPlaybackTimelineSnapshot?.(
      run.turnId,
      run.messageId,
    ) ?? null;
    options.onMotionLabRawEvent({
      event_type: event.status === "completed"
        ? "motion.playback_completed"
        : "motion.playback_failed",
      message_id: run.messageId,
      source_route: "frontend_motion_player",
      phase: "playback_terminal",
      profile_id: run.profileId,
      profile_revision: run.profileRevision,
      raw: {
        playbackOrigin: run.playbackOrigin,
        runId: event.runId,
        status: event.status,
        reason: event.reason ?? "",
        turnId: run.turnId,
        messageId: run.messageId,
        transform_trace: run.transformTrace,
        timeline_outcome: {
          motion: event.status,
          reason: event.reason ?? "",
          timeline_phase: timeline?.phase ?? "missing",
          clock_source: timeline?.clockSource ?? "missing",
          sinks: Object.fromEntries(
            (timeline?.sinks ?? []).map((sink) => [
              sink.id,
              {
                required: sink.required,
                terminal: sink.id === "motion" ? event.status : sink.terminal,
                reason: sink.id === "motion"
                  ? event.reason ?? ""
                  : sink.reason ?? "",
              },
            ]),
          ),
        },
      },
    }, run.turnId);
  }

  function resetMotionPlaybackRecorder(): void {
    currentMotionRun = null;
  }

  return {
    motionPlaybackRecords: shallowReadonly(motionPlaybackRecords),
    recordMotionPlayback,
    completeMotionPlayback,
    resetMotionPlaybackRecorder,
  };
}

function resolveEventProfileId(event: ModelEnginePlanStartedEvent): string {
  if (event.executionKind === "motion_resource") {
    return event.intent.profile_id;
  }
  return event.plan.profile_id;
}

function resolveEventProfileRevision(
  event: ModelEnginePlanStartedEvent,
): number | undefined {
  if (event.executionKind === "motion_resource") {
    return event.intent.profile_revision;
  }
  return event.plan.profile_revision;
}

function isDuplicateMotionPlaybackRecord(
  next: DesktopMotionPlaybackRecord,
  previous: DesktopMotionPlaybackRecord | undefined,
): boolean {
  if (!previous) {
    return false;
  }
  const nextCreatedAt = Date.parse(next.createdAt);
  const previousCreatedAt = Date.parse(previous.createdAt);
  if (
    Number.isFinite(nextCreatedAt)
    && Number.isFinite(previousCreatedAt)
    && Math.abs(nextCreatedAt - previousCreatedAt) > MOTION_RECORD_DEDUP_WINDOW_MS
  ) {
    return false;
  }
  return next.messageId === previous.messageId
    && next.turnId === previous.turnId
    && next.payloadKind === previous.payloadKind
    && next.startReason === previous.startReason;
}
