<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { cloneJson } from "../utils/cloneJson";
import { roundTo } from "../utils/number";
import {
  matchesProfileIdentityScope,
} from "../types/desktop";
import type {
  DesktopMotionTuningEffectiveExample,
  DesktopMotionPlaybackRecord,
  DesktopMotionTuningSample,
  DesktopMotionTuningSamplesStatus,
} from "../types/desktop";
import type {
  SemanticParameterPlan,
} from "../types/protocol";
import {
  SCHEMA_MOTION_TUNING_SAMPLE_V2,
  SCHEMA_PARAMETER_PLAN_V3,
} from "../types/protocol";
import type {
  CompiledSemanticMotion,
  PerformanceScheduleTrace,
  PerformanceTimingEventTrace,
} from "../types/compiledSemanticMotion";
import type {
  SemanticAxisDefinition,
  SemanticAxisProfile,
} from "../types/semantic-axis-profile";

const RECENT_RECORD_LIMIT = 5;
const props = defineProps<{
  semanticProfile: SemanticAxisProfile | null;
  motionPlaybackRecords: readonly DesktopMotionPlaybackRecord[];
  motionTuningSamples: readonly DesktopMotionTuningSample[];
  motionTuningSamplesStatus: DesktopMotionTuningSamplesStatus;
  effectiveExamples: readonly DesktopMotionTuningEffectiveExample[];
}>();
const emit = defineEmits<{
  requestMotionTuningSamplesSync: [];
  previewCompiledSemanticMotion: [semanticMotion: CompiledSemanticMotion];
  saveMotionTuningSample: [sample: DesktopMotionTuningSample];
  deleteMotionTuningSample: [sampleId: string];
}>();
const selectedRecordId = ref("");
const selectedReferenceId = ref("");
const activeSourceTab = ref<"history" | "saved">("history");
const emotionLabelText = ref("");
const feedbackText = ref("");
const tagsText = ref("");
const enabledForLlmReference = ref(true);
const draftAxes = reactive<Record<string, number>>({});
const explicitDraftAxisIds = reactive(new Set<string>());
const playStatusText = ref("");
const saveStatusText = ref("");
type MotionTuningSampleSnapshot = Readonly<{
  schemaVersion: typeof SCHEMA_MOTION_TUNING_SAMPLE_V2;
  id: string;
  createdAt: string;
  sourceRecordId: string;
  turnId: string;
  messageId: string;
  modelName: string;
  profileId?: string;
  profileRevision?: number;
  profileHash?: string;
  transformVersion?: string;
  emotionLabel: string;
  userText: string;
  assistantText: string;
  feedback: string;
  tags: readonly string[];
  enabledForLlmReference?: boolean;
  originalAxes: Readonly<Record<string, number>>;
  rawAxisLevels?: Readonly<Record<string, number>>;
  resolvedAxes?: Readonly<Record<string, number>>;
  constrainedAxes?: Readonly<Record<string, number>>;
  adjustedAxes?: Readonly<Record<string, number>>;
  compiledSemanticMotion: CompiledSemanticMotion;
}>;
type LlmReferenceEntry = Readonly<{
  id: string;
  title: string;
  subtitle: string;
  description: string;
  axes: Record<string, number>;
  tags: readonly string[];
  sourceLabel: string;
  enabled: boolean;
  sample?: DesktopMotionTuningSample;
}>;
type MotionDraftSource = Readonly<{
  id: string;
  sourceRecordId: string;
  turnId: string;
  messageId: string;
  mode: "expressive" | "idle";
  emotionLabel: string;
  assistantText: string;
  createdAt: string;
  sourceLabel: string;
  motionKind: "pose" | "sequence";
  axes: Record<string, number>;
  explicitAxisIds: readonly string[];
  error?: string;
  durationMs: number;
  record?: DesktopMotionPlaybackRecord & { plan: SemanticParameterPlan };
  sample?: DesktopMotionTuningSample;
}>;

type SemanticMotionPlaybackRecord = DesktopMotionPlaybackRecord & {
  payloadKind: "semantic_intent" | "speech_only";
  plan: SemanticParameterPlan;
};
type MotionVisibilitySummary = Record<string, unknown> & {
  axis_count?: number;
  parameter_count?: number;
  target_duration_ms?: number;
  max_delta_from_neutral?: number;
  neutralish_axis_count?: number;
  expressive_axis_count?: number;
  skeleton_groups?: string[];
  skeleton_groups_present?: string[];
  missing_skeleton_groups?: string[];
  outside_soft_range_axes?: string[];
  pose_descriptors?: string[];
};

const currentProfile = computed<SemanticAxisProfile | null>(() => props.semanticProfile);
const promptAxes = computed(() => {
  const profile = currentProfile.value;
  if (!profile) {
    return [];
  }
  return profile.axes.filter((axis) =>
    axis.control_role === "primary" || axis.control_role === "hint",
  );
});
const recentSemanticRecords = computed(() =>
  {
    const profile = currentProfile.value;
    if (!profile) {
      return [];
    }
    return props.motionPlaybackRecords
      .filter(isSemanticMotionPlaybackRecord)
      .filter((record) => record.plan.model_id === profile.model_id)
      .filter((record) => record.plan.profile_id === profile.profile_id)
      .slice(0, RECENT_RECORD_LIMIT);
  },
);
const historyDraftSources = computed<MotionDraftSource[]>(() =>
  recentSemanticRecords.value.map(buildHistoryDraftSource),
);
const llmReferenceSampleCount = computed(() =>
  llmReferenceEntries.value.filter((entry) => entry.enabled).length,
);
const motionTuningLoadError = computed(() => props.motionTuningSamplesStatus.loadError.trim());
const motionTuningRootError = computed(() => props.motionTuningSamplesStatus.rootError.trim());
const motionTuningDiagnostics = computed(() => props.motionTuningSamplesStatus.diagnostics);
const effectiveExamples = computed(() => props.effectiveExamples);
const llmReferenceEntries = computed<LlmReferenceEntry[]>(() => {
  const entries: LlmReferenceEntry[] = [];

  for (const sample of savedSamples.value) {
    entries.push({
      id: `sample:${sample.id}`,
      title: sample.emotionLabel || "用户样本",
      subtitle: sample.modelName || "unknown model",
      description: sample.feedback || sample.assistantText || "暂无说明",
      axes: { ...(sample.adjustedAxes ?? {}) },
      tags: sample.tags,
      sourceLabel: "用户样本",
      enabled: Boolean(sample.enabledForLlmReference),
      sample,
    });
  }

  const knownEntryKeys = new Set(
    entries.map((entry) => normalizeEmotionKey(entry.title)),
  );

  for (const example of effectiveExamples.value) {
    if (formatEffectiveExampleSource(example) !== "default") {
      continue;
    }
    const emotionKey = normalizeEmotionKey(example.category);
    if (knownEntryKeys.has(emotionKey)) {
      continue;
    }
    entries.push({
      id: `effective:default:${emotionKey}:${entries.length}`,
      title: example.category || "默认参考",
      subtitle: "默认兜底",
      description: example.input || "默认关键词参考",
      axes: extractEffectiveExampleAxes(example),
      tags: example.tags,
      sourceLabel: "默认参考",
      enabled: true,
    });
    knownEntryKeys.add(emotionKey);
  }

  return entries;
});
const savedDraftSources = computed<MotionDraftSource[]>(() =>
  llmReferenceEntries.value.flatMap((entry) => {
    const sample = entry.sample;
    if (!sample) {
      return [];
    }
    return [{
      id: entry.id,
      sourceRecordId: sample.sourceRecordId,
      turnId: sample.turnId,
      messageId: sample.messageId,
      mode: sample.compiledSemanticMotion.mode,
      emotionLabel: entry.title || "reference",
      assistantText: sample.assistantText || entry.description,
      createdAt: sample.createdAt,
      sourceLabel: entry.sourceLabel,
      motionKind: sample.compiledSemanticMotion.kind,
      axes: { ...entry.axes },
      explicitAxisIds: Object.keys(entry.axes),
      durationMs: sample.compiledSemanticMotion.timing.resolvedDurationMs,
      sample,
    }];
  }),
);
const selectedSavedSource = computed(() =>
  savedDraftSources.value.find((source) => source.id === selectedReferenceId.value)
    ?? savedDraftSources.value[0]
    ?? null,
);
const selectedDraftSource = computed<MotionDraftSource | null>(() => {
  if (activeSourceTab.value === "saved") {
    return selectedSavedSource.value;
  }
  return historyDraftSources.value.find(
    (source) => source.id === selectedRecordId.value,
  ) ?? historyDraftSources.value[0] ?? null;
});
const selectedMotionDiagnosticLines = computed(() =>
  buildMotionDiagnosticLines(selectedDraftSource.value),
);

const effectiveExampleCoverage = computed(() => {
  const groups = [
    { label: "neutral", keys: ["neutral"] },
    { label: "happy", keys: ["happy", "joy"] },
    { label: "angry", keys: ["angry"] },
    { label: "surprised", keys: ["surprised"] },
    { label: "confused / embarrassed", keys: ["confused", "embarrassed", "blush", "question"] },
  ];
  return groups.map((group) => {
    const matchedExample = effectiveExamples.value.find((example) =>
      group.keys.includes(normalizeEmotionKey(example.category)),
    );
    return {
      label: group.label,
      covered: Boolean(matchedExample),
      source: matchedExample ? formatEffectiveExampleSource(matchedExample) : "",
    };
  });
});
const savedSamples = computed(() =>
  props.motionTuningSamples.filter((sample) =>
    matchesCurrentProfileSample(sample, currentProfile.value)),
);

onMounted(() => {
  emit("requestMotionTuningSamplesSync");
});

watch(
  historyDraftSources,
  (sources) => {
    if (!sources.length) {
      selectedRecordId.value = "";
      return;
    }
    if (!sources.some((source) => source.id === selectedRecordId.value)) {
      selectedRecordId.value = sources[0].id;
    }
  },
  { immediate: true },
);

watch(
  savedDraftSources,
  (sources) => {
    if (!sources.length) {
      selectedReferenceId.value = "";
      return;
    }
    if (!sources.some((source) => source.id === selectedReferenceId.value)) {
      selectedReferenceId.value = sources[0].id;
    }
  },
  { immediate: true },
);

watch(
  selectedDraftSource,
  (source) => {
    resetDraftAxes(source);
    emotionLabelText.value = source?.emotionLabel ?? "";
    feedbackText.value = source?.sample?.feedback ?? "";
    tagsText.value = source ? getDraftTags(source).join(", ") : "";
    enabledForLlmReference.value = source?.sample
      ? Boolean(source.sample.enabledForLlmReference)
      : true;
    playStatusText.value = "";
    saveStatusText.value = "";
  },
  { immediate: true },
);

watch(
  () => {
    const profile = currentProfile.value;
    if (!profile) {
      return "";
    }
    return `${profile.model_id}:${profile.revision}`;
  },
  () => {
    resetDraftAxes(selectedDraftSource.value);
    playStatusText.value = "";
    saveStatusText.value = "";
  },
);

function resetDraftAxes(source: MotionDraftSource | null): void {
  for (const key of Object.keys(draftAxes)) {
    delete draftAxes[key];
  }
  explicitDraftAxisIds.clear();
  if (!source) {
    return;
  }
  if (source.motionKind === "sequence") {
    return;
  }

  const sourceExplicitAxisIds = new Set(source.explicitAxisIds);
  for (const axis of promptAxes.value) {
    const sourceValue = source.axes[axis.id];
    const value = sourceValue ?? axis.neutral;
    draftAxes[axis.id] = value;
    if (sourceExplicitAxisIds.has(axis.id)) {
      explicitDraftAxisIds.add(axis.id);
    }
  }
}

function buildHistoryDraftSource(record: SemanticMotionPlaybackRecord): MotionDraftSource {
  const trace = record.diagnostics?.transformTrace;
  const base = {
    id: `record:${record.id}`,
    sourceRecordId: record.id,
    turnId: record.turnId ?? "",
    messageId: record.messageId,
    mode: record.mode,
    emotionLabel: record.emotionLabel || "motion",
    assistantText: record.assistantText || record.startReason,
    createdAt: record.createdAt,
    sourceLabel: "历史动作",
    durationMs: record.plan.timing.duration_ms,
    record,
  } as const;
  if (!trace) {
    return {
      ...base,
      motionKind: record.semanticMotion.kind,
      axes: {},
      explicitAxisIds: [],
      error: "motion_tuning_transform_trace_missing",
    };
  }
  if (trace.rawMotionSteps?.length) {
    if (record.semanticMotion.kind !== "sequence") {
      return {
        ...base,
        motionKind: "pose",
        axes: {},
        explicitAxisIds: [],
        error: "motion_tuning_sequence_trace_kind_mismatch",
      };
    }
    return {
      ...base,
      motionKind: "sequence",
      axes: {},
      explicitAxisIds: [],
    };
  }
  if (record.semanticMotion.kind === "sequence") {
    return {
      ...base,
      motionKind: "sequence",
      axes: {},
      explicitAxisIds: [],
      error: "motion_tuning_sequence_trace_missing",
    };
  }

  const explicitAxisIds = Object.keys(
    Object.keys(trace.rawAxisLevels ?? {}).length
      ? trace.rawAxisLevels ?? {}
      : trace.rawAxes,
  );
  const axes: Record<string, number> = {};
  for (const axisId of explicitAxisIds) {
    const value = trace.constrainedAxes[axisId];
    if (!Number.isFinite(value)) {
      return {
        ...base,
        motionKind: "pose",
        axes: {},
        explicitAxisIds: [],
        error: `motion_tuning_explicit_axis_value_missing:${axisId}`,
      };
    }
    axes[axisId] = value;
  }
  if (!explicitAxisIds.length) {
    return {
      ...base,
      motionKind: "pose",
      axes: {},
      explicitAxisIds: [],
      error: "motion_tuning_explicit_axes_missing",
    };
  }
  return {
    ...base,
    motionKind: "pose",
    axes,
    explicitAxisIds,
  };
}

function isSemanticMotionPlaybackRecord(
  record: DesktopMotionPlaybackRecord,
): record is SemanticMotionPlaybackRecord {
  return (
    (record.payloadKind === "semantic_intent" || record.payloadKind === "speech_only")
    && Boolean(record.plan)
    && record.plan.schema_version === SCHEMA_PARAMETER_PLAN_V3
  );
}

function updateAxisValue(axis: SemanticAxisDefinition, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  const value = Number(target.value);
  if (!Number.isFinite(value)) {
    return;
  }
  draftAxes[axis.id] = clamp(value, axis.value_range[0], axis.value_range[1]);
  explicitDraftAxisIds.add(axis.id);
}

function buildAdjustedSemanticMotion(): CompiledSemanticMotion | null {
  const profile = currentProfile.value;
  const source = selectedDraftSource.value;
  if (!profile || !source) {
    return null;
  }
  if (source.error) {
    return null;
  }
  const recorded = source.record?.semanticMotion ?? source.sample?.compiledSemanticMotion;
  if (!recorded) {
    return null;
  }
  const intentTags = parseTags(tagsText.value);
  if (!intentTags.length) {
    return null;
  }
  const emotionLabel = normalizeEmotionLabel(emotionLabelText.value, source.emotionLabel);
  if (source.motionKind === "sequence") {
    if (recorded.kind !== "sequence") {
      return null;
    }
    return {
      ...cloneJson(recorded),
      emotionLabel,
      intentTags,
    };
  }

  const axes: Record<string, number> = {};
  for (const axis of promptAxes.value) {
    if (!explicitDraftAxisIds.has(axis.id)) {
      continue;
    }
    const value = Number(draftAxes[axis.id] ?? axis.neutral);
    if (!Number.isFinite(value)) {
      continue;
    }
    axes[axis.id] = clamp(value, axis.value_range[0], axis.value_range[1]);
  }

  if (!Object.keys(axes).length) {
    return null;
  }

  if (recorded.kind !== "pose") {
    return null;
  }
  return {
    ...cloneJson(recorded),
    kind: "pose",
    emotionLabel,
    intentTags,
    axes: Object.entries(axes).map(([axisId, value]) => ({
      axisId,
      value,
      neutralValue: profile.axes.find((axis) => axis.id === axisId)?.neutral ?? 0,
      source: "semantic_axis" as const,
    })),
  };
}

function playAdjustedIntent(): void {
  if (selectedDraftSource.value?.error) {
    playStatusText.value = `当前记录不可编辑：${selectedDraftSource.value.error}`;
    return;
  }
  const semanticMotion = buildAdjustedSemanticMotion();
  if (!semanticMotion) {
    playStatusText.value = "当前没有可播放的语义主轴草稿。";
    return;
  }

  emit("previewCompiledSemanticMotion", semanticMotion);
  playStatusText.value = "";
}

function playRecordedPlan(): void {
  const record = selectedDraftSource.value?.record;
  if (!record?.semanticMotion) {
    playStatusText.value = "当前没有可重放的历史动作计划。";
    return;
  }

  emit("previewCompiledSemanticMotion", cloneJson(record.semanticMotion));
  playStatusText.value = "";
}

function saveSample(): void {
  const source = selectedDraftSource.value;
  const profile = currentProfile.value;
  if (!source || !profile) {
    saveStatusText.value = "当前没有可保存的动作参考或主轴 profile。";
    return;
  }
  if (source.error) {
    saveStatusText.value = `当前记录不可保存：${source.error}`;
    return;
  }

  const compiledSemanticMotion = buildAdjustedSemanticMotion();
  if (!compiledSemanticMotion) {
    saveStatusText.value = "当前第一阶段动作结果无效，无法保存。";
    return;
  }
  if (!source.turnId || !source.messageId || !source.sourceRecordId) {
    saveStatusText.value = "当前记录缺少完整 turn/message 身份，无法安全保存为参考样本。";
    return;
  }
  const now = new Date();
  const emotionLabel = normalizeEmotionLabel(emotionLabelText.value, source.emotionLabel);
  const sample: DesktopMotionTuningSample = {
    schemaVersion: SCHEMA_MOTION_TUNING_SAMPLE_V2,
    id: `motion-sample-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now.toISOString(),
    sourceRecordId: source.sourceRecordId,
    turnId: source.turnId,
    messageId: source.messageId,
    modelName: profile.model_id,
    profileId: profile.profile_id,
    profileRevision: profile.revision,
    profileHash: source.record?.diagnostics?.transformTrace?.profileHash ?? profile.source_hash,
    transformVersion: source.record?.diagnostics?.transformTrace?.transformVersion ?? "",
    emotionLabel,
    userText: source.sample?.userText ?? "",
    assistantText: source.sample?.assistantText ?? source.assistantText,
    feedback: source.motionKind === "pose" ? feedbackText.value.trim() : source.sample?.feedback ?? "",
    tags: parseTags(tagsText.value),
    enabledForLlmReference: enabledForLlmReference.value,
    originalAxes: source.motionKind === "pose" ? { ...source.axes } : {},
    rawAxisLevels: {
      ...(source.record?.diagnostics?.transformTrace?.rawAxisLevels ?? {}),
    },
    resolvedAxes: {
      ...(source.record?.diagnostics?.transformTrace?.resolvedAxes ?? source.axes),
    },
    constrainedAxes: {
      ...(source.record?.diagnostics?.transformTrace?.constrainedAxes ?? source.axes),
    },
    adjustedAxes: source.motionKind === "pose" ? normalizeDraftAxes(profile) : undefined,
    compiledSemanticMotion,
  };

  emit("saveMotionTuningSample", sample);
  saveStatusText.value = sample.enabledForLlmReference
    ? "样本保存请求已提交到后端，保存后会进入后端 few-shot 参考池。"
    : "样本保存请求已提交到后端，但暂不作为大模型参考例子。";
}

function toggleSampleReference(sample: MotionTuningSampleSnapshot, enabled: boolean): void {
  const mutableSample = cloneJson(sample) as DesktopMotionTuningSample;
  emit(
    "saveMotionTuningSample",
    {
      ...mutableSample,
      tags: [...mutableSample.tags],
      originalAxes: { ...mutableSample.originalAxes },
      rawAxisLevels: { ...(mutableSample.rawAxisLevels ?? {}) },
      resolvedAxes: { ...(mutableSample.resolvedAxes ?? {}) },
      constrainedAxes: { ...(mutableSample.constrainedAxes ?? {}) },
      adjustedAxes: mutableSample.adjustedAxes
        ? { ...mutableSample.adjustedAxes }
        : undefined,
      compiledSemanticMotion: cloneJson(mutableSample.compiledSemanticMotion),
      enabledForLlmReference: enabled,
    },
  );
}

function deleteSample(sampleId: string): void {
  emit("deleteMotionTuningSample", sampleId);
}

function matchesCurrentProfileSample(
  sample: MotionTuningSampleSnapshot,
  currentProfile: SemanticAxisProfile | null,
): boolean {
  return matchesProfileIdentityScope(sample, currentProfile);
}

function normalizeDraftAxes(currentProfile: SemanticAxisProfile): Record<string, number> {
  const result: Record<string, number> = {};
  for (const axis of currentProfile.axes) {
    if (axis.control_role !== "primary" && axis.control_role !== "hint") {
      continue;
    }
    if (!explicitDraftAxisIds.has(axis.id)) {
      continue;
    }
    const value = Number(draftAxes[axis.id] ?? axis.neutral);
    result[axis.id] = roundTo(clamp(value, axis.value_range[0], axis.value_range[1]), 4);
  }
  return result;
}


function parseTags(value: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value.split(/[,，\s]+/)) {
    const tag = item.trim();
    if (!tag || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function formatRecordTime(record: { createdAt: string }): string {
  const date = new Date(record.createdAt);
  if (Number.isNaN(date.getTime())) {
    return record.createdAt;
  }
  return date.toLocaleTimeString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatEffectiveExampleSource(example: DesktopMotionTuningEffectiveExample): string {
  if (example.source === "desktop_motion_tuning_sample_store") {
    return "user";
  }
  return example.source || "default";
}

function extractEffectiveExampleAxes(
  example: DesktopMotionTuningEffectiveExample,
): Record<string, number> {
  if (example.output.axisLevels) {
    return { ...example.output.axisLevels };
  }
  return example.output.motionSteps?.[0]?.axisLevels
    ? { ...example.output.motionSteps[0].axisLevels }
    : {};
}

function getDraftTags(source: MotionDraftSource): string[] {
  if (source.sample?.tags.length) {
    return [...source.sample.tags];
  }
  const motion = source.record?.semanticMotion ?? source.sample?.compiledSemanticMotion;
  return motion?.intentTags ? [...motion.intentTags] : [];
}

function formatAxisList(axes: Record<string, number>): string {
  return Object.keys(axes).join(", ");
}

function buildMotionDiagnosticLines(source: MotionDraftSource | null): string[] {
  const record = source?.record;
  if (!record) {
    return [];
  }
  const lines: string[] = source.error ? [`不可编辑: ${source.error}`] : [];
  const summary = (record.plan.summary ?? {}) as MotionVisibilitySummary;
  const diagnostics = record.diagnostics;
  const warningLines = uniqueStrings([
    ...(diagnostics?.warnings ?? []),
    ...(record.plan.diagnostics?.warnings ?? []),
  ]);
  appendMetric(lines, "轴", summary.axis_count ?? diagnostics?.semanticAxisCount);
  appendMetric(lines, "参数", summary.parameter_count ?? diagnostics?.compiledParameterCount);
  appendMetric(lines, "时长", summary.target_duration_ms ?? record.plan.timing.duration_ms, "ms");
  appendMetric(lines, "最大偏移", pickNumber(summary.max_delta_from_neutral, diagnostics?.maxDeltaFromNeutral));
  appendList(lines, "骨架", pickStringList(
    summary.skeleton_groups,
    summary.skeleton_groups_present,
    diagnostics?.skeletonGroups,
  ));
  appendList(lines, "缺骨架", pickStringList(summary.missing_skeleton_groups, diagnostics?.missingSkeletonGroups));
  appendMetric(lines, "soft内轴", pickNumber(summary.neutralish_axis_count, diagnostics?.neutralishAxisCount));
  appendMetric(lines, "表达轴", pickNumber(summary.expressive_axis_count, diagnostics?.expressiveAxisCount));
  appendList(lines, "越过soft轴", pickStringList(summary.outside_soft_range_axes));
  appendList(lines, "姿态描述", pickStringList(summary.pose_descriptors));
  appendList(lines, "关系图跳过", diagnostics?.relationSkippedExplicitTargets);
  appendPerformanceScheduleDiagnostics(
    lines,
    diagnostics?.transformTrace?.performanceSchedule,
  );
  appendList(lines, "编译/计划警告", warningLines.slice(0, 8));
  return lines;
}

function appendPerformanceScheduleDiagnostics(
  lines: string[],
  schedule: PerformanceScheduleTrace | undefined,
): void {
  if (!schedule) {
    return;
  }
  const semanticEventCount = schedule.events.filter((event) =>
    event.kind === "semantic_transition",
  ).length;
  const gazeEventCount = schedule.events.filter((event) =>
    event.kind.startsWith("gaze_"),
  ).length;
  const speechEventCount = schedule.events.length - semanticEventCount - gazeEventCount;
  const keyframeNodeCount = schedule.parameterNodes.filter((node) =>
    node.trackKind === "keyframe",
  ).length;
  const speechNodeCount = schedule.parameterNodes.length - keyframeNodeCount;
  lines.push(
    `编排: ${schedule.phrases.length} phrase / ${schedule.semanticSteps.length} step / ${schedule.events.length} event / ${schedule.parameterNodes.length} node`,
  );
  lines.push(
    `事件来源: semantic ${semanticEventCount}, gaze ${gazeEventCount}, speech ${speechEventCount}; 参数节点: keyframe ${keyframeNodeCount}, modulation ${speechNodeCount}`,
  );
  const nodesByEventId = new Map<string, typeof schedule.parameterNodes>();
  for (const node of schedule.parameterNodes) {
    const nodes = nodesByEventId.get(node.eventId) ?? [];
    nodes.push(node);
    nodesByEventId.set(node.eventId, nodes);
  }
  for (const event of schedule.events.slice(0, 10)) {
    const nodes = nodesByEventId.get(event.id) ?? [];
    lines.push(`${formatPerformanceEvent(event)} -> ${formatPerformanceNodes(nodes)}`);
  }
  if (schedule.events.length > 10) {
    lines.push(`编排事件其余 ${schedule.events.length - 10} 条已省略`);
  }
}

function formatPerformanceEvent(event: PerformanceTimingEventTrace): string {
  const source = event.stepIndex === undefined
    ? event.phraseIndices?.length
      ? `phrase ${event.phraseIndices.map((index) => index + 1).join("/")}`
      : event.kind
    : `step ${event.stepIndex + 1}`;
  const localAtMs = event.localAtMs === undefined ? "" : ` local ${event.localAtMs}ms`;
  return `${event.kind} (${source}) / ${event.semanticAxisId} @${event.atMs}ms${localAtMs} transition ${event.transitionMs}ms`;
}

function formatPerformanceNodes(
  nodes: readonly PerformanceScheduleTrace["parameterNodes"][number][],
): string {
  if (!nodes.length) {
    return "无最终参数节点";
  }
  return nodes
    .map((node) => `${node.parameterId} ${node.trackKind}#${node.nodeIndex}`)
    .join(", ");
}

function appendMetric(
  lines: string[],
  label: string,
  value: unknown,
  suffix = "",
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return;
  }
  lines.push(`${label}: ${roundTo(value, 3)}${suffix}`);
}

function appendList(lines: string[], label: string, value: unknown): void {
  if (!Array.isArray(value) || !value.length) {
    return;
  }
  const items = value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 12);
  if (items.length) {
    lines.push(`${label}: ${items.join(", ")}`);
  }
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function pickStringList(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      const items = uniqueStrings(value);
      if (items.length) {
        return items;
      }
    }
  }
  return undefined;
}

function uniqueStrings(value: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    const text = String(item || "").trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    items.push(text);
  }
  return items;
}

function normalizeEmotionLabel(value: string, fallback: string): string {
  return value.trim().slice(0, 80) || fallback.trim() || "manual_tuning";
}

function toggleDraftSourceReference(source: MotionDraftSource, event: Event): void {
  const enabled = (event.target as HTMLInputElement).checked;
  if (source.sample) {
    toggleSampleReference(source.sample, enabled);
  }
}

function normalizeEmotionKey(value: string): string {
  return String(value || "").trim().toLowerCase();
}

</script>

<template>
  <article class="settings-card settings-card--wide motion-tuning">
    <div class="settings-card__header">
      <div>
        <p class="settings-card__eyebrow">历史动作微调</p>
        <h2>最近 5 次大模型控制参数样本</h2>
      </div>
      <span class="settings-card__badge">
        {{ recentSemanticRecords.length }} recent / {{ llmReferenceSampleCount }} LLM refs
      </span>
    </div>

    <p class="settings-card__copy">
      选择最近一次真实播放过的动作，手动微调 primary / hint 轴及其绑定参数，点击播放观察 Live2D 效果。
      保存后的样本可以作为 few-shot 参考同步给后端大模型，用来约束后续动作生成风格。
    </p>

    <details v-if="llmReferenceEntries.length" class="motion-tuning__details">
      <summary>LLM 参考覆盖</summary>
      <div class="motion-tuning__coverage-grid">
        <div
          v-for="item in effectiveExampleCoverage"
          :key="item.label"
          class="motion-tuning__coverage-item"
          :data-covered="item.covered"
        >
          <strong>{{ item.label }}</strong>
          <small>{{ item.covered ? item.source : "missing" }}</small>
        </div>
      </div>
    </details>

    <p v-if="motionTuningRootError" class="history-empty">
      后端 runtime cache 根状态异常：{{ motionTuningRootError }}
    </p>

    <p v-else-if="motionTuningLoadError" class="history-empty">
      后端动作调参样本池加载失败：{{ motionTuningLoadError }}
    </p>

    <ul v-else-if="motionTuningDiagnostics.length" class="motion-tuning__sample-list">
      <li
        v-for="diagnostic in motionTuningDiagnostics"
        :key="diagnostic"
        class="motion-tuning__sample-item"
      >
        <div>
          <strong>few-shot 诊断</strong>
          <p>{{ diagnostic }}</p>
        </div>
      </li>
    </ul>

    <template v-if="currentProfile && (historyDraftSources.length || savedDraftSources.length)">
      <div class="motion-tuning__layout">
        <aside class="motion-tuning__records">
          <div class="motion-tuning__tabs" role="tablist" aria-label="动作样本来源">
            <button
              type="button"
              class="motion-tuning__tab"
              :data-active="activeSourceTab === 'history'"
              @click="activeSourceTab = 'history'"
            >
              历史动作 {{ historyDraftSources.length }}
            </button>
            <button
              type="button"
              class="motion-tuning__tab"
              :data-active="activeSourceTab === 'saved'"
              @click="activeSourceTab = 'saved'"
            >
              已保存 {{ savedDraftSources.length }}
            </button>
          </div>
          <template v-if="activeSourceTab === 'history'">
            <button
              v-for="source in historyDraftSources"
              :key="source.id"
              type="button"
              class="profile-editor__axis-button"
              :data-selected="source.id === selectedDraftSource?.id"
              @click="selectedRecordId = source.id"
            >
              <strong>{{ source.emotionLabel }}</strong>
              <span>{{ source.mode }} · {{ formatRecordTime(source) }}</span>
              <small>{{ source.assistantText }}</small>
              <small
                v-if="source.record"
                class="motion-tuning__diagnostic-chip"
              >
                {{ buildMotionDiagnosticLines(source).slice(0, 3).join(" · ") || "暂无诊断" }}
              </small>
            </button>
          </template>
          <template v-else>
            <button
              v-for="source in savedDraftSources"
              :key="source.id"
              type="button"
              class="profile-editor__axis-button"
              :data-selected="source.id === selectedDraftSource?.id"
              @click="selectedReferenceId = source.id"
            >
              <strong>{{ source.emotionLabel }}</strong>
              <span>{{ source.sourceLabel }}</span>
              <small>{{ formatAxisList(source.axes) || "暂无语义轴映射" }}</small>
            </button>
          </template>
        </aside>

        <section class="motion-tuning__editor">
          <div v-if="selectedDraftSource" class="motion-tuning__source-header">
            <div>
              <strong>{{ selectedDraftSource.emotionLabel }}</strong>
              <p>{{ selectedDraftSource.assistantText || selectedDraftSource.sourceLabel }}</p>
            </div>
            <div class="motion-tuning__sample-actions">
              <span class="settings-card__badge">{{ selectedDraftSource.sourceLabel }}</span>
              <label
                v-if="selectedDraftSource.sample"
                class="profile-editor__toggle"
              >
                <input
                  type="checkbox"
                  :checked="Boolean(selectedDraftSource.sample.enabledForLlmReference)"
                  @change="toggleDraftSourceReference(selectedDraftSource, $event)"
                />
                <span>LLM 参考</span>
              </label>
              <button
                v-if="selectedDraftSource.sample"
                type="button"
                class="settings-card__button settings-card__button--ghost"
                @click="deleteSample(selectedDraftSource.sample.id)"
              >
                删除
              </button>
            </div>
          </div>
          <details
            v-if="selectedDraftSource?.record && selectedMotionDiagnosticLines.length"
            class="motion-tuning__details motion-tuning__diagnostics"
          >
            <summary>动作诊断</summary>
            <ul>
              <li
                v-for="line in selectedMotionDiagnosticLines"
                :key="line"
              >
                {{ line }}
              </li>
            </ul>
          </details>
          <p
            v-if="selectedDraftSource?.motionKind === 'sequence' && !selectedDraftSource.error"
            class="history-empty"
          >
            这是保留原始 motion_steps 的序列样本。可以回放、保存和作为 Prompt 参考，但不会被压缩成单个姿态轴。
          </p>

          <div
            v-if="selectedDraftSource?.motionKind === 'pose' && !selectedDraftSource.error"
            class="motion-tuning__axis-grid"
          >
            <label
              v-for="axis in promptAxes"
              :key="axis.id"
              class="action-preview__field"
            >
              <span>{{ axis.label }} / {{ axis.id }} · {{ axis.control_role }}</span>
              <input
                :value="draftAxes[axis.id] ?? axis.neutral"
                class="settings-card__input"
                type="range"
                :min="axis.value_range[0]"
                :max="axis.value_range[1]"
                step="0.1"
                @input="updateAxisValue(axis, $event)"
              />
              <input
                :value="draftAxes[axis.id] ?? axis.neutral"
                class="settings-card__input"
                type="number"
                :min="axis.value_range[0]"
                :max="axis.value_range[1]"
                step="0.1"
                @input="updateAxisValue(axis, $event)"
              />
            </label>
          </div>

          <p v-if="selectedDraftSource?.error" class="history-empty">
            当前记录仅支持原始重放：{{ selectedDraftSource.error }}
          </p>

          <label
            v-if="!selectedDraftSource?.error"
            class="action-preview__field profile-editor__field--full"
          >
            <span>Emotion label / 表情标签</span>
            <input
              v-model="emotionLabelText"
              class="settings-card__input"
              maxlength="80"
              placeholder="例如：happy, confused, wink, shy"
            />
          </label>

          <label
            v-if="selectedDraftSource?.motionKind === 'pose' && !selectedDraftSource.error"
            class="action-preview__field profile-editor__field--full"
          >
            <span>样本说明 / 调参反馈</span>
            <textarea
              v-model="feedbackText"
              class="motion-tuning__textarea"
              placeholder="例如：开心时嘴角更明显，头部只轻微上扬，避免眼睛过大。"
            />
          </label>

          <label v-if="!selectedDraftSource?.error" class="action-preview__field">
            <span>标签</span>
            <input
              v-model="tagsText"
              class="settings-card__input"
              placeholder="joy, subtle, smile"
            />
          </label>

          <label v-if="!selectedDraftSource?.error" class="settings-toggle">
            <input
              v-model="enabledForLlmReference"
              class="settings-toggle__input"
              type="checkbox"
            />
            <span class="settings-toggle__control" aria-hidden="true"></span>
            <span class="settings-toggle__copy">
              保存后作为例子提供给大模型参考
            </span>
          </label>

          <div class="settings-card__actions">
            <button
              v-if="selectedDraftSource?.record"
              type="button"
              class="settings-card__button settings-card__button--ghost"
              @click="playRecordedPlan"
            >
              播放原始记录
            </button>
            <button
              v-if="!selectedDraftSource?.error"
              type="button"
              class="settings-card__button"
              @click="playAdjustedIntent"
            >
              {{ selectedDraftSource?.motionKind === 'sequence' ? "播放序列效果" : "播放手调效果" }}
            </button>
            <button
              v-if="!selectedDraftSource?.error"
              type="button"
              class="settings-card__button"
              @click="saveSample"
            >
              保存样本
            </button>
            <span>{{ playStatusText || saveStatusText }}</span>
          </div>
        </section>
      </div>
    </template>

    <p v-else class="history-empty">
      还没有可微调的动作参考。完成一次对话动作播放，或等待模型同步扫描表情后，这里会显示可编辑样本。
    </p>

  </article>
</template>

<style scoped>
.motion-tuning__layout {
  display: grid;
  grid-template-columns: minmax(220px, 0.8fr) minmax(0, 1.5fr);
  gap: 16px;
}

.motion-tuning__records,
.motion-tuning__editor,
.motion-tuning__axis-grid {
  display: grid;
  gap: 12px;
}

.motion-tuning__axis-grid {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.motion-tuning__source-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 12px;
  background: rgba(148, 163, 184, 0.06);
}

.motion-tuning__sample-list {
  display: grid;
  gap: 10px;
  padding: 0;
  list-style: none;
}

.motion-tuning__sample-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 12px;
}

.motion-tuning__sample-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.motion-tuning__tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 12px 0;
}

.motion-tuning__tab {
  border: 1px solid rgba(148, 163, 184, 0.28);
  background: rgba(148, 163, 184, 0.08);
  color: inherit;
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
}

.motion-tuning__tab[data-active="true"] {
  border-color: rgba(59, 130, 246, 0.45);
  background: rgba(59, 130, 246, 0.12);
}

.motion-tuning__coverage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin: 12px 0;
}

.motion-tuning__coverage-item,
.motion-tuning__sample-group {
  padding: 10px 12px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 12px;
}

.motion-tuning__coverage-item[data-covered="true"] {
  border-color: rgba(34, 197, 94, 0.35);
}

.motion-tuning__diagnostic-chip {
  color: rgba(71, 85, 105, 0.86);
  font-size: 11px;
  line-height: 1.45;
}

.motion-tuning__diagnostics ul {
  display: grid;
  gap: 6px;
  margin: 10px 0 0;
  padding-left: 18px;
  color: rgba(51, 65, 85, 0.92);
  font-size: 12px;
}

.motion-tuning__sample-group {
  background: rgba(148, 163, 184, 0.08);
}

@media (max-width: 820px) {
  .motion-tuning__layout {
    grid-template-columns: 1fr;
  }
}
</style>
