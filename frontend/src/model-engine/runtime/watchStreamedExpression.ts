import { watch } from "vue";
import type { ModelEnginePlanStartedEvent } from "./contracts.js";
import type { TurnPlaybackSessionPort } from "../../turn-playback/sessionStorePort.js";
import type { ModelSummary } from "../../types/protocol.js";
import type { ModelEngineSettings } from "../settings.js";
import type { Live2dRuntimePort } from "../../live2d/runtimePort.js";
import { compileParameterMotionIntent } from "../compiler/compileParameterMotionIntent.js";

export function watchStreamedExpression(
  event: ModelEnginePlanStartedEvent, store: TurnPlaybackSessionPort, model: ModelSummary | null,
  settings: ModelEngineSettings, runtime: Live2dRuntimePort,
) {
  if (event.playbackOrigin !== "conversation" || event.executionKind !== "parameter_plan"
    || event.payloadKind !== "semantic_intent" || !model) return null;
  const session = store.getSession(event.turnId);
  const segment = session?.segments.get(event.messageId);
  const stream = segment?.incremental?.streams.motion;
  const originalIntent = event.intent;
  const initial = originalIntent.motion_steps;
  if (!session || !segment || !stream || !initial?.length || initial.some(step => step.ms === undefined)) return null;

  let applied = initial;
  const stop = watch(
    () => [segment.motion.payload, stream.status, session.interrupted, segment.audio.terminal] as const,
    ([payload, status, interrupted, audio]) => {
      const playable = !interrupted && (audio === "idle" || audio === "absent");
      const open = status === "open" && playable;
      runtime.updateDirectParameterStream(event.runId, open);
      if (!payload || !playable || status === "failed" || status === "cancelled") return;
      const intent = payload.intent;
      const steps = intent.motion_steps;
      if (!steps || steps.length <= applied.length || steps.some(step => step.ms === undefined)
        || intent.profile_id !== event.intent.profile_id || intent.profile_revision !== event.intent.profile_revision
        || intent.model_id !== event.intent.model_id || intent.expression_resource_id !== event.intent.expression_resource_id
        || !applied.every((step, index) => step.ms === steps[index].ms
          && Object.keys(step.axis_values).length === Object.keys(steps[index].axis_values).length
          && Object.entries(step.axis_values).every(([axis, value]) => steps[index].axis_values[axis] === value))) return;
      const revision = { ...originalIntent, motion_steps: steps.map(step => ({ ...step })) };
      const result = compileParameterMotionIntent(revision, {
        model, settings, assistantText: segment.text.content ?? "", speechCues: segment.speech.cues,
        source: event.startReason, motionSource: event.motionSource, speechActive: true, conversationExpression: true,
        samplingIdentity: { turnId: event.turnId ?? "", messageId: event.messageId },
      });
      const fromMs = applied.reduce((total, step) => total + (step.ms ?? 0), 0);
      if (result.ok && result.plan && runtime.updateDirectParameterStream(event.runId, open, result.plan, fromMs)) {
        applied = revision.motion_steps;
      }
    }, { immediate: true },
  );
  return {
    runId: event.runId,
    steps: () => applied,
    stop() {
      stop();
      runtime.updateDirectParameterStream(event.runId, false);
    },
  };
}
