<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import {
  matchesPinnedProfileScope,
} from "../types/desktop";
import type {
  DesktopMotionPlaybackRecord,
  DesktopMotionTuningSample,
} from "../types/desktop";
import type {
  SemanticMotionIntent,
  SemanticParameterPlan,
} from "../types/protocol";
import type {
  SemanticAxisDefinition,
  SemanticAxisParameterBinding,
  SemanticAxisProfile,
} from "../types/semantic-axis-profile";

const RECENT_RECORD_LIMIT = 5;
const bridge = useDesktopBridge();
const selectedRecordId = ref("");
const feedbackText = ref("");
const tagsText = ref("");
const enabledForLlmReference = ref(true);
const draftAxes = reactive<Record<string, number>>({});
const playStatusText = ref("");
const saveStatusText = ref("");
type MotionTuningSampleSnapshot = Readonly<{
  id: string;
  createdAt: string;
  sourceRecordId: string;
  modelName: string;
  profileId?: string;
  profileRevision?: number;
  emotionLabel: string;
  assistantText: string;
  feedback: string;
  tags: readonly string[];
  enabledForLlmReference?: boolean;
  originalAxes: Readonly<Record<string, number>>;
  adjustedAxes: Readonly<Record<string, number>>;
  adjustedPlan: unknown;
}>;

const profile = computed(() => bridge.state.snapshot.runtimeSemanticAxisProfile);
const mutableProfile = computed<SemanticAxisProfile | null>(() =>
  profile.value ? cloneJson(profile.value) as SemanticAxisProfile : null,
);
const promptAxes = computed(() => {
  const currentProfile = mutableProfile.value;
  if (!currentProfile) {
    return [];
  }
  return currentProfile.axes.filter((axis) =>
    axis.control_role === "primary" || axis.control_role === "hint",
  );
});
const recentSemanticRecords = computed(() =>
  {
    const currentProfile = mutableProfile.value;
    if (!currentProfile) {
      return [];
    }
    return bridge.state.snapshot.motionPlaybackRecords
      .filter((record): record is DesktopMotionPlaybackRecord & { plan: SemanticParameterPlan } =>
      record.plan.schema_version === "engine.parameter_plan.v2",
      )
      .filter((record) => record.plan.model_id === currentProfile.model_id)
      .filter((record) => record.plan.profile_revision === currentProfile.revision)
      .slice(0, RECENT_RECORD_LIMIT);
  },
);
const selectedRecord = computed(() =>
  recentSemanticRecords.value.find((record) => record.id === selectedRecordId.value)
    ?? recentSemanticRecords.value[0]
    ?? null,
);
const llmReferenceSampleCount = computed(() =>
  bridge.state.motionTuningSamples.filter((sample) =>
    matchesCurrentProfileSample(sample, mutableProfile.value) && sample.enabledForLlmReference).length,
);
const savedSamples = computed(() =>
  bridge.state.motionTuningSamples.filter((sample) =>
    matchesCurrentProfileSample(sample, mutableProfile.value)),
);

onMounted(() => {
  bridge.sendCommand({ type: "request_motion_tuning_samples_sync" });
});

watch(
  recentSemanticRecords,
  (records) => {
    if (!records.length) {
      selectedRecordId.value = "";
      resetDraftAxes(null);
      return;
    }
    if (!records.some((record) => record.id === selectedRecordId.value)) {
      selectedRecordId.value = records[0].id;
    }
  },
  { immediate: true },
);

watch(
  selectedRecord,
  (record) => {
    resetDraftAxes(record);
    feedbackText.value = "";
    tagsText.value = "";
    enabledForLlmReference.value = true;
    playStatusText.value = "";
    saveStatusText.value = "";
  },
  { immediate: true },
);

watch(
  () => {
    const currentProfile = mutableProfile.value;
    if (!currentProfile) {
      return "";
    }
    return `${currentProfile.model_id}:${currentProfile.revision}`;
  },
  () => {
    resetDraftAxes(selectedRecord.value);
    playStatusText.value = "";
    saveStatusText.value = "";
  },
);

function resetDraftAxes(record: DesktopMotionPlaybackRecord | null): void {
  for (const key of Object.keys(draftAxes)) {
    delete draftAxes[key];
  }
  if (!record || record.plan.schema_version !== "engine.parameter_plan.v2") {
    return;
  }

  const recordedValues = extractPlanAxisValues(record.plan);
  for (const axis of promptAxes.value) {
    draftAxes[axis.id] = recordedValues[axis.id] ?? axis.neutral;
  }
}

function extractPlanAxisValues(plan: SemanticParameterPlan): Record<string, number> {
  const values: Record<string, number> = {};
  for (const parameter of plan.parameters) {
    if (parameter.input_value === undefined || values[parameter.axis_id] !== undefined) {
      continue;
    }
    values[parameter.axis_id] = parameter.input_value;
  }
  return values;
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
}

function buildAdjustedIntent(): SemanticMotionIntent | null {
  const currentProfile = mutableProfile.value;
  const record = selectedRecord.value;
  if (!currentProfile || !record) {
    return null;
  }

  const axes: SemanticMotionIntent["axes"] = {};
  for (const axis of promptAxes.value) {
    const value = Number(draftAxes[axis.id] ?? axis.neutral);
    if (!Number.isFinite(value)) {
      continue;
    }
    axes[axis.id] = {
      value: clamp(value, axis.value_range[0], axis.value_range[1]),
    };
  }

  if (!Object.keys(axes).length) {
    return null;
  }

  return {
    schema_version: "engine.motion_intent.v2",
    profile_id: currentProfile.profile_id,
    profile_revision: currentProfile.revision,
    model_id: currentProfile.model_id,
    mode: record.mode,
    emotion_label: record.emotionLabel || "manual_tuning",
    duration_hint_ms: record.plan.timing.duration_ms,
    axes,
    summary: {
      axis_count: Object.keys(axes).length,
    },
  };
}

function playAdjustedIntent(): void {
  const intent = buildAdjustedIntent();
  if (!intent) {
    playStatusText.value = "当前没有可播放的语义主轴草稿。";
    return;
  }

  bridge.sendCommand({
    type: "preview_motion_payload",
    payload: intent,
  });
  playStatusText.value = "已发送手调主轴预览，请观察 Live2D 效果。";
}

function saveSample(): void {
  const record = selectedRecord.value;
  const currentProfile = mutableProfile.value;
  if (!record || !currentProfile) {
    saveStatusText.value = "当前没有可保存的动作记录或主轴 profile。";
    return;
  }

  const adjustedAxes = normalizeDraftAxes(currentProfile);
  const now = new Date();
  const sample: DesktopMotionTuningSample = {
    id: `motion-sample-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now.toISOString(),
    sourceRecordId: record.id,
    modelName: currentProfile.model_id,
    profileId: currentProfile.profile_id,
    profileRevision: currentProfile.revision,
    emotionLabel: record.emotionLabel || "manual_tuning",
    assistantText: record.assistantText,
    feedback: feedbackText.value.trim(),
    tags: parseTags(tagsText.value),
    enabledForLlmReference: enabledForLlmReference.value,
    originalAxes: extractPlanAxisValues(record.plan),
    adjustedAxes,
    adjustedPlan: buildAdjustedPlan(record.plan, currentProfile, adjustedAxes),
  };

  bridge.sendCommand({
    type: "save_motion_tuning_sample",
    sample,
  });
  saveStatusText.value = sample.enabledForLlmReference
    ? "样本保存请求已提交到后端，保存后会进入后端 few-shot 参考池。"
    : "样本保存请求已提交到后端，但暂不作为大模型参考例子。";
}

function toggleSampleReference(sample: MotionTuningSampleSnapshot, enabled: boolean): void {
  const mutableSample = cloneJson(sample) as DesktopMotionTuningSample;
  bridge.sendCommand({
    type: "save_motion_tuning_sample",
    sample: {
      ...mutableSample,
      tags: [...mutableSample.tags],
      originalAxes: { ...mutableSample.originalAxes },
      adjustedAxes: { ...mutableSample.adjustedAxes },
      adjustedPlan: cloneJson(mutableSample.adjustedPlan),
      enabledForLlmReference: enabled,
    },
  });
}

function handleSampleReferenceToggle(sample: MotionTuningSampleSnapshot, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  toggleSampleReference(sample, target.checked);
}

function deleteSample(sampleId: string): void {
  bridge.sendCommand({
    type: "delete_motion_tuning_sample",
    sampleId,
  });
}

function matchesCurrentProfileSample(
  sample: MotionTuningSampleSnapshot,
  currentProfile: SemanticAxisProfile | null,
): boolean {
  return matchesPinnedProfileScope(sample, currentProfile);
}

function normalizeDraftAxes(currentProfile: SemanticAxisProfile): Record<string, number> {
  const result: Record<string, number> = {};
  for (const axis of currentProfile.axes) {
    if (axis.control_role !== "primary" && axis.control_role !== "hint") {
      continue;
    }
    const value = Number(draftAxes[axis.id] ?? axis.neutral);
    result[axis.id] = roundTo(clamp(value, axis.value_range[0], axis.value_range[1]), 4);
  }
  return result;
}

function buildAdjustedPlan(
  basePlan: SemanticParameterPlan,
  currentProfile: SemanticAxisProfile,
  adjustedAxes: Record<string, number>,
): SemanticParameterPlan {
  const parameters: SemanticParameterPlan["parameters"] = [];
  const seenParameterIds = new Set<string>();
  const promptAxisIds = new Set(promptAxes.value.map((axis) => axis.id));

  for (const axis of currentProfile.axes) {
    if (!promptAxisIds.has(axis.id)) {
      continue;
    }

    const axisValue = adjustedAxes[axis.id];
    if (!Number.isFinite(axisValue)) {
      continue;
    }

    for (const binding of axis.parameter_bindings) {
      if (seenParameterIds.has(binding.parameter_id)) {
        continue;
      }

      seenParameterIds.add(binding.parameter_id);
      parameters.push(buildManualPlanParameter(axis, binding, axisValue));
    }
  }

  return {
    ...basePlan,
    parameters,
    diagnostics: {
      warnings: [
        ...(basePlan.diagnostics?.warnings ?? []),
        "manual_motion_tuning_sample",
      ],
    },
    summary: {
      ...(basePlan.summary ?? {}),
      axis_count: Object.keys(adjustedAxes).length,
      parameter_count: parameters.length,
    },
  };
}

function buildManualPlanParameter(
  axis: SemanticAxisDefinition,
  binding: SemanticAxisParameterBinding,
  axisValue: number,
): SemanticParameterPlan["parameters"][number] {
  return {
    axis_id: axis.id,
    parameter_id: binding.parameter_id,
    target_value: mapBindingValue(axisValue, binding.input_range, binding.output_range, binding.invert),
    weight: binding.default_weight,
    input_value: axisValue,
    source: "manual",
  };
}

function mapBindingValue(
  value: number,
  inputRange: [number, number],
  outputRange: [number, number],
  invert: boolean,
): number {
  const [inputMin, inputMax] = inputRange;
  if (inputMax === inputMin) {
    return outputRange[0];
  }
  const ratio = clamp((value - inputMin) / (inputMax - inputMin), 0, 1);
  const effectiveRatio = invert ? 1 - ratio : ratio;
  return roundTo(outputRange[0] + (outputRange[1] - outputRange[0]) * effectiveRatio, 4);
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

function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function cloneJson<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
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

    <template v-if="mutableProfile && recentSemanticRecords.length">
      <div class="motion-tuning__layout">
        <aside class="motion-tuning__records">
          <button
            v-for="record in recentSemanticRecords"
            :key="record.id"
            type="button"
            class="profile-editor__axis-button"
            :data-selected="record.id === selectedRecord?.id"
            @click="selectedRecordId = record.id"
          >
            <strong>{{ record.emotionLabel || "motion" }}</strong>
            <span>{{ record.mode }} · {{ formatRecordTime(record) }}</span>
            <small>{{ record.assistantText || record.startReason }}</small>
          </button>
        </aside>

        <section class="motion-tuning__editor">
          <div class="motion-tuning__axis-grid">
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

          <label class="action-preview__field profile-editor__field--full">
            <span>样本说明 / 调参反馈</span>
            <textarea
              v-model="feedbackText"
              class="motion-tuning__textarea"
              placeholder="例如：开心时嘴角更明显，头部只轻微上扬，避免眼睛过大。"
            />
          </label>

          <label class="action-preview__field">
            <span>标签</span>
            <input
              v-model="tagsText"
              class="settings-card__input"
              placeholder="joy, subtle, smile"
            />
          </label>

          <label class="settings-toggle">
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
            <button type="button" class="settings-card__button" @click="playAdjustedIntent">
              播放手调效果
            </button>
            <button type="button" class="settings-card__button" @click="saveSample">
              保存样本
            </button>
            <span>{{ playStatusText || saveStatusText }}</span>
          </div>
        </section>
      </div>
    </template>

    <p v-else class="history-empty">
      还没有可微调的 v2 动作记录。完成一次对话动作播放后，这里会显示最近 5 次历史动作。
    </p>

    <details v-if="savedSamples.length" class="motion-tuning__details">
      <summary>已保存样本（可切换是否作为大模型参考）</summary>
      <ul class="motion-tuning__sample-list">
        <li
          v-for="sample in savedSamples"
          :key="sample.id"
          class="motion-tuning__sample-item"
        >
          <div>
            <strong>{{ sample.emotionLabel }} · {{ sample.modelName || "unknown model" }}</strong>
            <p>{{ sample.feedback || "未填写反馈说明" }}</p>
            <small>{{ sample.tags.join(", ") || "no tags" }}</small>
          </div>
          <label class="profile-editor__toggle">
            <input
              type="checkbox"
              :checked="Boolean(sample.enabledForLlmReference)"
              @change="handleSampleReferenceToggle(sample, $event)"
            />
            <span>LLM 参考</span>
          </label>
          <button
            type="button"
            class="settings-card__button settings-card__button--ghost"
            @click="deleteSample(sample.id)"
          >
            删除
          </button>
        </li>
      </ul>
    </details>
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

.motion-tuning__sample-list {
  display: grid;
  gap: 10px;
  padding: 0;
  list-style: none;
}

.motion-tuning__sample-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 12px;
}

@media (max-width: 820px) {
  .motion-tuning__layout {
    grid-template-columns: 1fr;
  }
}
</style>
