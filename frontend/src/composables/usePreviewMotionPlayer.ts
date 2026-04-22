import { reactive, readonly } from "vue";
import type { ModelSummary, MotionConstraint } from "../types/protocol";

type PreviewPlayerStatus = "idle" | "playing" | "finished" | "failed";

interface ParsedMotionPlanStep {
  atomId: string;
  channel: string;
  startMs: number;
  durationMs: number;
  intensity: number;
  sourceMotion: string;
  sourceFile: string;
  sourceGroup: string;
}

interface ParsedMotionPlanParameters {
  durationScale: number;
  intensityScale: number;
  sequentialGapMs: number;
  targetDurationMs: number;
  durationScaleApplied: boolean;
}

interface ParsedMotionPlan {
  mode: "parallel" | "sequential";
  steps: ParsedMotionPlanStep[];
  totalDurationMs: number;
  parameters: ParsedMotionPlanParameters;
}

interface MotionIndexEntry {
  motion: MotionConstraint;
  group: string;
  indexInGroup: number;
  normalizedFile: string;
  normalizedFileBase: string;
  normalizedFileStem: string;
  normalizedName: string;
  normalizedNameBase: string;
  normalizedNameStem: string;
}

interface MotionIndex {
  entries: MotionIndexEntry[];
  byGroup: Map<string, MotionIndexEntry[]>;
}

const state = reactive({
  status: "idle" as PreviewPlayerStatus,
  message: "等待播放动作计划。",
  runningSteps: 0,
  totalSteps: 0,
  startedAt: "",
  finishedAt: "",
});

let activeRunId = 0;
let activeTimerHandles: number[] = [];

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizePath(value: string): string {
  return normalizeText(value).replace(/\\/g, "/").toLowerCase();
}

function normalizeGroup(value: string): string {
  return normalizeText(value).toLowerCase();
}

function basename(pathValue: string): string {
  const normalized = normalizePath(pathValue);
  if (!normalized) {
    return "";
  }
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? "";
}

function stripJsonSuffix(value: string): string {
  return normalizePath(value)
    .replace(/\.motion3\.json$/i, "")
    .replace(/\.json$/i, "");
}

function normalizeScale(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(0.1, Math.min(parsed, 5));
}

function parseMotionPlan(plan: unknown): ParsedMotionPlan | null {
  if (!plan || typeof plan !== "object") {
    return null;
  }

  const rawPlan = plan as {
    mode?: unknown;
    steps?: unknown;
    parameters?: unknown;
  };
  const mode = rawPlan.mode === "sequential" ? "sequential" : "parallel";
  const rawParameters =
    rawPlan.parameters && typeof rawPlan.parameters === "object"
      ? (rawPlan.parameters as Record<string, unknown>)
      : {};
  const durationScale = normalizeScale(rawParameters.duration_scale, 1);
  const intensityScale = normalizeScale(rawParameters.intensity_scale, 1);
  const targetDurationMs = Math.max(
    0,
    Math.round(Number(rawParameters.target_duration_ms ?? 0) || 0),
  );
  const sequentialGapMs = Math.max(
    0,
    Math.round(Number(rawParameters.sequential_gap_ms ?? 0) || 0),
  );
  const rawSteps = Array.isArray(rawPlan.steps) ? rawPlan.steps : [];
  const normalizedRawSteps = rawSteps
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const rawStep = item as Record<string, unknown>;
      return {
        atomId: normalizeText(rawStep.atom_id),
        channel: normalizeText(rawStep.channel),
        startMs: Math.max(0, Math.round(Number(rawStep.start_ms ?? 0) || 0)),
        durationMs: Math.max(80, Math.round(Number(rawStep.duration_ms ?? 0) || 0)),
        intensityRaw: Number(rawStep.intensity ?? 1),
        sourceMotion: normalizeText(rawStep.source_motion),
        sourceFile: normalizeText(rawStep.source_file),
        sourceGroup: normalizeText(rawStep.source_group),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const rawTotalDurationMs = Math.max(
    ...normalizedRawSteps.map((step) => step.startMs + step.durationMs),
    0,
  );

  let applyDurationScale = durationScale !== 1;
  if (applyDurationScale && targetDurationMs > 0 && rawTotalDurationMs > 0) {
    const projectedDurationMs = rawTotalDurationMs * durationScale;
    const rawDistance = Math.abs(rawTotalDurationMs - targetDurationMs);
    const scaledDistance = Math.abs(projectedDurationMs - targetDurationMs);
    applyDurationScale = scaledDistance + 40 < rawDistance;
  }

  const resolvedDurationScale = applyDurationScale ? durationScale : 1;

  let steps: ParsedMotionPlanStep[] = normalizedRawSteps
    .map((rawStep) => {
      const startMs = Math.max(0, Math.round(rawStep.startMs * resolvedDurationScale));
      const durationMs = Math.max(80, Math.round(rawStep.durationMs * resolvedDurationScale));
      const intensity = rawStep.intensityRaw * intensityScale;
      const normalizedIntensity = Number.isFinite(intensity)
        ? Math.max(0.05, Math.min(intensity, 3))
        : 1;

      return {
        atomId: rawStep.atomId,
        channel: rawStep.channel,
        startMs,
        durationMs,
        intensity: Number(normalizedIntensity.toFixed(3)),
        sourceMotion: rawStep.sourceMotion,
        sourceFile: rawStep.sourceFile,
        sourceGroup: rawStep.sourceGroup,
      } satisfies ParsedMotionPlanStep;
    })
    .filter((item): item is ParsedMotionPlanStep => Boolean(item))
    .sort((left, right) => left.startMs - right.startMs);

  if (mode === "sequential" && steps.length > 1 && sequentialGapMs > 0) {
    let previousEndMs = 0;
    steps = steps.map((step, index) => {
      if (index === 0) {
        previousEndMs = step.startMs + step.durationMs;
        return step;
      }

      const minStartMs = previousEndMs + sequentialGapMs;
      const nextStep = {
        ...step,
        startMs: Math.max(step.startMs, minStartMs),
      };
      previousEndMs = nextStep.startMs + nextStep.durationMs;
      return nextStep;
    });
  }

  if (!steps.length) {
    return null;
  }

  const totalDurationMs = Math.max(
    ...steps.map((step) => step.startMs + step.durationMs),
    0,
  );

  return {
    mode,
    steps,
    totalDurationMs,
    parameters: {
      durationScale,
      intensityScale,
      sequentialGapMs,
      targetDurationMs,
      durationScaleApplied: applyDurationScale,
    },
  };
}

function buildMotionIndex(model: ModelSummary): MotionIndex {
  const byGroup = new Map<string, MotionIndexEntry[]>();
  const entries: MotionIndexEntry[] = [];
  const motions = Array.isArray(model.constraints?.motions)
    ? model.constraints.motions
    : [];

  for (const motion of motions) {
    const normalizedGroup = normalizeGroup(motion.group);
    const groupEntries = byGroup.get(normalizedGroup) ?? [];
    const normalizedFile = normalizePath(motion.file);
    const normalizedName = normalizePath(motion.name);
    const entry: MotionIndexEntry = {
      motion,
      group: normalizedGroup,
      indexInGroup: groupEntries.length,
      normalizedFile,
      normalizedFileBase: basename(normalizedFile),
      normalizedFileStem: stripJsonSuffix(normalizedFile),
      normalizedName,
      normalizedNameBase: basename(normalizedName),
      normalizedNameStem: stripJsonSuffix(normalizedName),
    };
    groupEntries.push(entry);
    byGroup.set(normalizedGroup, groupEntries);
    entries.push(entry);
  }

  return { entries, byGroup };
}

function matchSourceRef(entry: MotionIndexEntry, sourceRef: string): boolean {
  const target = normalizePath(sourceRef);
  if (!target) {
    return false;
  }

  const targetBase = basename(target);
  const targetStem = stripJsonSuffix(target);
  const targetBaseStem = stripJsonSuffix(targetBase);

  if (
    entry.normalizedFile === target
    || entry.normalizedFileBase === targetBase
    || entry.normalizedFileStem === targetStem
    || entry.normalizedFileStem === targetBaseStem
  ) {
    return true;
  }

  if (
    entry.normalizedName === target
    || entry.normalizedNameBase === targetBase
    || entry.normalizedNameStem === targetStem
    || entry.normalizedNameStem === targetBaseStem
  ) {
    return true;
  }

  return false;
}

function resolveStepToMotion(
  step: ParsedMotionPlanStep,
  motionIndex: MotionIndex,
): MotionIndexEntry | null {
  const sourceGroup = normalizeGroup(step.sourceGroup);
  const scopedEntries = sourceGroup
    ? (motionIndex.byGroup.get(sourceGroup) ?? [])
    : motionIndex.entries;
  const candidates = scopedEntries.length ? scopedEntries : motionIndex.entries;

  if (step.sourceFile) {
    const byFile = candidates.find((entry) => matchSourceRef(entry, step.sourceFile));
    if (byFile) {
      return byFile;
    }
  }

  if (step.sourceMotion) {
    const byMotion = candidates.find((entry) => matchSourceRef(entry, step.sourceMotion));
    if (byMotion) {
      return byMotion;
    }
  }

  if (sourceGroup && scopedEntries.length) {
    return scopedEntries[0] ?? null;
  }

  return null;
}

function resolveMotionPriority(intensity: number): number {
  if (intensity >= 1.35) {
    return 3;
  }
  if (intensity >= 0.75) {
    return 2;
  }
  return 1;
}

function playMotionStep(entry: MotionIndexEntry, intensity: number): boolean {
  const adapter = window.getLAppAdapter?.();
  if (!adapter || typeof adapter.startMotion !== "function") {
    return false;
  }

  const handle = adapter.startMotion(
    entry.motion.group,
    entry.indexInGroup,
    resolveMotionPriority(intensity),
  );
  if (typeof handle === "number" && handle < 0) {
    return false;
  }
  return Boolean(handle);
}

function clearActiveTimers(): void {
  for (const handle of activeTimerHandles) {
    window.clearTimeout(handle);
  }
  activeTimerHandles = [];
}

function stopPlan(reason = "stopped"): void {
  activeRunId += 1;
  clearActiveTimers();
  state.runningSteps = 0;
  if (state.status === "playing") {
    state.status = "idle";
    state.message = reason === "stopped"
      ? "动作计划已停止。"
      : `动作计划已停止（${reason}）。`;
    state.finishedAt = new Date().toISOString();
  }
}

function scheduleTimer(runId: number, delayMs: number, fn: () => void): void {
  const timerHandle = window.setTimeout(() => {
    if (runId !== activeRunId) {
      return;
    }
    fn();
  }, Math.max(0, Math.round(delayMs)));
  activeTimerHandles.push(timerHandle);
}

function playPlan(plan: unknown, model: ModelSummary | null): boolean {
  const parsed = parseMotionPlan(plan);
  if (!parsed) {
    state.status = "failed";
    state.message = "动作计划无效：缺少可用 steps。";
    state.finishedAt = new Date().toISOString();
    return false;
  }

  if (!model) {
    state.status = "failed";
    state.message = "动作计划无法执行：当前没有已同步模型。";
    state.finishedAt = new Date().toISOString();
    return false;
  }

  const motionIndex = buildMotionIndex(model);
  if (!motionIndex.entries.length) {
    state.status = "failed";
    state.message = "动作计划无法执行：当前模型没有可用 motion。";
    state.finishedAt = new Date().toISOString();
    return false;
  }

  activeRunId += 1;
  const runId = activeRunId;
  clearActiveTimers();

  state.status = "playing";
  const durationScaleLabel = parsed.parameters.durationScaleApplied
    ? parsed.parameters.durationScale.toFixed(2)
    : `${parsed.parameters.durationScale.toFixed(2)}(skip)`;
  state.message = `正在执行动作计划（${parsed.mode}, ${parsed.steps.length} steps, duration_scale=${durationScaleLabel}, intensity_scale=${parsed.parameters.intensityScale.toFixed(2)}）...`;
  state.runningSteps = 0;
  state.totalSteps = parsed.steps.length;
  state.startedAt = new Date().toISOString();
  state.finishedAt = "";

  let failedSteps = 0;

  for (const step of parsed.steps) {
    scheduleTimer(runId, step.startMs, () => {
      const resolved = resolveStepToMotion(step, motionIndex);
      if (!resolved || !playMotionStep(resolved, step.intensity)) {
        failedSteps += 1;
      }
      state.runningSteps += 1;
    });
  }

  scheduleTimer(runId, parsed.totalDurationMs + 260, () => {
    if (failedSteps > 0) {
      state.status = "failed";
      state.message = `动作计划执行结束，但有 ${failedSteps} 个 step 未成功播放。`;
    } else {
      state.status = "finished";
      state.message = "动作计划执行完成。";
    }
    state.finishedAt = new Date().toISOString();
    activeTimerHandles = [];
  });

  return true;
}

export function usePreviewMotionPlayer() {
  return {
    state: readonly(state),
    playPlan,
    stopPlan,
  };
}
