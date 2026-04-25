<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import { DIRECT_PARAMETER_AXIS_NAMES } from "../model-engine/constants";
import { MOTION_AXIS_LABELS } from "../model-engine/settings";
import type {
  DesktopMotionPlaybackRecord,
  DesktopMotionTuningSample,
} from "../types/desktop";
import type {
  DirectParameterAxisName,
  DirectParameterPlan,
} from "../types/protocol";

const bridge = useDesktopBridge();
const selectedRecordId = ref("");
const feedbackText = ref("");
const tagsText = ref("");
const playStatusText = ref("");
const pendingSavedSampleId = ref("");
const preserveSupplementaryParams = ref(true);
const editedAxes = reactive<Record<DirectParameterAxisName, number>>(
  buildCenteredAxes(),
);

const playbackRecords = computed(() => bridge.state.snapshot.motionPlaybackRecords);
const tuningSamples = computed(() => bridge.state.snapshot.motionTuningSamples);
const selectedRecord = computed(() =>
  playbackRecords.value.find((record) => record.id === selectedRecordId.value)
  ?? playbackRecords.value[0]
  ?? null
);
const selectedRecordPlanText = computed(() =>
  selectedRecord.value
    ? JSON.stringify(selectedRecord.value.plan, null, 2)
    : "",
);
const adjustedPlan = computed<DirectParameterPlan | null>(() => {
  const record = selectedRecord.value;
  if (!record) {
    return null;
  }
  return buildAdjustedPlan(record.plan);
});
const adjustedPlanText = computed(() =>
  adjustedPlan.value ? JSON.stringify(adjustedPlan.value, null, 2) : "",
);
const axisRows = computed(() =>
  DIRECT_PARAMETER_AXIS_NAMES.map((axisName) => {
    const originalValue = Number(
      selectedRecord.value?.plan.key_axes[axisName]?.value ?? 50,
    );
    const adjustedValue = editedAxes[axisName];
    return {
      axisName,
      label: MOTION_AXIS_LABELS[axisName],
      originalValue,
      adjustedValue,
      delta: adjustedValue - originalValue,
    };
  })
);

watch(
  () => playbackRecords.value.map((record) => record.id).join("|"),
  () => {
    if (!playbackRecords.value.length) {
      selectedRecordId.value = "";
      resetEditedAxesToCenter();
      return;
    }
    if (!playbackRecords.value.some((record) => record.id === selectedRecordId.value)) {
      selectedRecordId.value = playbackRecords.value[0].id;
    }
  },
  { immediate: true },
);

watch(
  () => selectedRecord.value?.id ?? "",
  () => {
    resetEditedAxesToRecord();
    feedbackText.value = "";
    tagsText.value = "";
    playStatusText.value = "";
    pendingSavedSampleId.value = "";
  },
  { immediate: true },
);

watch(
  () => tuningSamples.value.map((sample) => sample.id).join("|"),
  () => {
    const pendingSampleId = pendingSavedSampleId.value;
    if (!pendingSampleId) {
      return;
    }
    if (tuningSamples.value.some((sample) => sample.id === pendingSampleId)) {
      pendingSavedSampleId.value = "";
      playStatusText.value = "样本已由桌宠窗口确认保存。";
    }
  },
);

function buildCenteredAxes(): Record<DirectParameterAxisName, number> {
  const axes = {} as Record<DirectParameterAxisName, number>;
  for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
    axes[axisName] = 50;
  }
  return axes;
}

function resetEditedAxesToRecord(): void {
  const record = selectedRecord.value;
  if (!record) {
    resetEditedAxesToCenter();
    return;
  }
  for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
    editedAxes[axisName] = clampAxisValue(
      record.plan.key_axes[axisName]?.value ?? 50,
    );
  }
}

function resetEditedAxesToCenter(): void {
  for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
    editedAxes[axisName] = 50;
  }
}

function scaleEditedAxes(multiplier: number): void {
  for (const axisName of DIRECT_PARAMETER_AXIS_NAMES) {
    const currentValue = Number(editedAxes[axisName] ?? 50);
    editedAxes[axisName] = clampAxisValue(
      50 + (currentValue - 50) * multiplier,
    );
  }
}

function setAxisValue(axisName: DirectParameterAxisName, value: number): void {
  editedAxes[axisName] = clampAxisValue(value);
}

function handleAxisInput(axisName: DirectParameterAxisName, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  setAxisValue(axisName, Number(target.value));
}

function buildAdjustedPlan(plan: unknown): DirectParameterPlan {
  const nextPlan = cloneJson(plan) as DirectParameterPlan;
  nextPlan.key_axes = Object.fromEntries(
    DIRECT_PARAMETER_AXIS_NAMES.map((axisName) => [
      axisName,
      { value: clampAxisValue(editedAxes[axisName]) },
    ]),
  ) as DirectParameterPlan["key_axes"];
  if (!preserveSupplementaryParams.value) {
    nextPlan.supplementary_params = [];
  }

  nextPlan.summary = {
    ...(nextPlan.summary ?? {}),
    key_axes_count: DIRECT_PARAMETER_AXIS_NAMES.length,
    supplementary_count: nextPlan.supplementary_params.length,
  };
  return nextPlan;
}

function playAdjustedPlan(): void {
  const plan = adjustedPlan.value;
  if (!plan) {
    playStatusText.value = "没有可播放的动作记录。";
    return;
  }
  bridge.sendCommand({
    type: "preview_motion_plan",
    plan,
  });
  playStatusText.value = "已发送播放命令；是否起播以桌宠窗口日志和新播放记录为准。";
}

function saveTuningSample(): void {
  const record = selectedRecord.value;
  const plan = adjustedPlan.value;
  if (!record || !plan) {
    playStatusText.value = "没有可保存的动作记录。";
    return;
  }

  const now = new Date();
  const sample: DesktopMotionTuningSample = {
    id: `motion-sample-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now.toISOString(),
    sourceRecordId: record.id,
    modelName: record.modelName,
    emotionLabel: record.emotionLabel,
    assistantText: record.assistantText,
    feedback: feedbackText.value.trim(),
    tags: tagsText.value
      .split(/[,\s]+/g)
      .map((tag) => tag.trim())
      .filter(Boolean),
    originalAxes: Object.fromEntries(
      DIRECT_PARAMETER_AXIS_NAMES.map((axisName) => [
        axisName,
        clampAxisValue(record.plan.key_axes[axisName]?.value ?? 50),
      ]),
    ) as Record<DirectParameterAxisName, number>,
    adjustedAxes: Object.fromEntries(
      DIRECT_PARAMETER_AXIS_NAMES.map((axisName) => [
        axisName,
        clampAxisValue(editedAxes[axisName]),
      ]),
    ) as Record<DirectParameterAxisName, number>,
    adjustedPlan: plan,
  };

  bridge.sendCommand({
    type: "save_motion_tuning_sample",
    sample,
  });
  pendingSavedSampleId.value = sample.id;
  playStatusText.value = "已发送保存命令，等待桌宠窗口确认。";
}

function deleteSample(sampleId: string): void {
  bridge.sendCommand({
    type: "delete_motion_tuning_sample",
    sampleId,
  });
  playStatusText.value = "已发送删除命令，等待快照刷新。";
}

function formatRecordTime(record: { createdAt: string }): string {
  const date = new Date(record.createdAt);
  if (Number.isNaN(date.getTime())) {
    return record.createdAt;
  }
  return date.toLocaleTimeString();
}

function formatAxisDelta(value: number): string {
  if (value === 0) {
    return "0";
  }
  return value > 0 ? `+${value}` : String(value);
}

function clampAxisValue(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    console.warn("[MotionTuningPanel] axis value is not finite; reset to center.", value);
    return 50;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function cloneJson<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}
</script>

<template>
  <article class="settings-card settings-card--wide motion-tuning">
    <div class="settings-card__header">
      <div>
        <p class="settings-card__eyebrow">ModelEngine 调参</p>
        <h2>最近播放参数回放</h2>
      </div>
      <span class="settings-card__badge">
        {{ playbackRecords.length }} records / {{ tuningSamples.length }} samples
      </span>
    </div>

    <template v-if="playbackRecords.length">
      <div class="motion-tuning__layout">
        <aside class="motion-tuning__records">
          <button
            v-for="record in playbackRecords"
            :key="record.id"
            type="button"
            class="motion-tuning__record"
            :data-selected="record.id === selectedRecord?.id"
            @click="selectedRecordId = record.id"
          >
            <strong>{{ record.emotionLabel }} · {{ record.mode }}</strong>
            <span>{{ formatRecordTime(record) }} · {{ record.source }}</span>
            <small>{{ record.modelName || "unknown model" }}</small>
          </button>
        </aside>

        <section class="motion-tuning__editor">
          <div class="motion-tuning__record-meta">
            <span>来源：{{ selectedRecord?.source }}</span>
            <span>起播：{{ selectedRecord?.startReason }}</span>
            <span>类型：{{ selectedRecord?.payloadKind }}</span>
            <span>supp：{{ selectedRecord?.plan.summary?.supplementary_count ?? selectedRecord?.plan.supplementary_params.length ?? 0 }}</span>
          </div>

          <p class="settings-card__hint">
            当前编辑的是最终写给 Live2D 的 12 轴参数。播放按钮会直接回放手调后的
            `engine.parameter_plan.v1`，用于观察真实体感。
          </p>

          <label class="motion-tuning__toggle">
            <input v-model="preserveSupplementaryParams" type="checkbox" />
            <span>
              保留 supplementary 连带参数
              <small>关闭后只回放 12 轴，便于隔离测试手调参数。</small>
            </span>
          </label>

          <div class="motion-tuning__axis-grid">
            <label
              v-for="row in axisRows"
              :key="row.axisName"
              class="settings-slider settings-slider--compact"
            >
              <div class="settings-slider__header">
                <div>
                  <strong>{{ row.label }}</strong>
                  <p>
                    {{ row.axisName }} · 原始 {{ row.originalValue }} · 差值
                    {{ formatAxisDelta(row.delta) }}
                  </p>
                </div>
                <span class="settings-slider__value">{{ row.adjustedValue }}</span>
              </div>
              <input
                :value="row.adjustedValue"
                class="settings-slider__input"
                type="range"
                min="0"
                max="100"
                step="1"
                @input="handleAxisInput(row.axisName, $event)"
              />
            </label>
          </div>

          <div class="settings-card__actions">
            <button type="button" class="settings-card__button" @click="playAdjustedPlan">
              播放手调结果
            </button>
            <button
              type="button"
              class="settings-card__button settings-card__button--ghost"
              @click="resetEditedAxesToRecord"
            >
              还原记录
            </button>
            <button
              type="button"
              class="settings-card__button settings-card__button--ghost"
              @click="resetEditedAxesToCenter"
            >
              全部回中
            </button>
            <button
              type="button"
              class="settings-card__button settings-card__button--ghost"
              @click="scaleEditedAxes(1.2)"
            >
              增强 20%
            </button>
            <button
              type="button"
              class="settings-card__button settings-card__button--ghost"
              @click="scaleEditedAxes(0.8)"
            >
              减弱 20%
            </button>
          </div>

          <div class="motion-tuning__sample-form">
            <label class="action-preview__field">
              <span>反馈说明</span>
              <textarea
                v-model="feedbackText"
                class="motion-tuning__textarea"
                placeholder="例如：笑容太弱，mouth_smile 和 head_pitch 需要更明显。"
              />
            </label>
            <label class="action-preview__field">
              <span>标签</span>
              <input
                v-model="tagsText"
                class="settings-card__input"
                placeholder="happy smile stronger"
              />
            </label>
            <div class="settings-card__actions">
              <button type="button" class="settings-card__button" @click="saveTuningSample">
                保存为样本
              </button>
              <span>{{ playStatusText }}</span>
            </div>
          </div>

          <details class="motion-tuning__details">
            <summary>查看原始 plan / 手调 plan</summary>
            <div class="motion-tuning__plan-columns">
              <textarea class="action-preview__plan-output" :value="selectedRecordPlanText" readonly />
              <textarea class="action-preview__plan-output" :value="adjustedPlanText" readonly />
            </div>
          </details>
        </section>
      </div>

      <section class="motion-tuning__samples">
        <header class="action-preview__group-header">
          <strong>已保存调参样本</strong>
          <span>{{ tuningSamples.length }} samples</span>
        </header>
        <ul v-if="tuningSamples.length" class="motion-tuning__sample-list">
          <li
            v-for="sample in tuningSamples"
            :key="sample.id"
            class="motion-tuning__sample-item"
          >
            <div>
              <strong>{{ sample.emotionLabel }} · {{ sample.modelName || "unknown model" }}</strong>
              <p>{{ sample.feedback || "未填写反馈说明" }}</p>
              <small>{{ sample.tags.join(", ") || "no tags" }}</small>
            </div>
            <button
              type="button"
              class="settings-card__button settings-card__button--ghost"
              @click="deleteSample(sample.id)"
            >
              删除
            </button>
          </li>
        </ul>
        <p v-else class="settings-card__hint">还没有保存调参样本。</p>
      </section>
    </template>

    <p v-else class="history-empty">
      暂无播放记录。先完成一次对话动作或在 Action Lab 中播放一次测试 plan。
    </p>
  </article>
</template>
