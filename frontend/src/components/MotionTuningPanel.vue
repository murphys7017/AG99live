<script setup lang="ts">
import { computed } from "vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import type {
  DesktopMotionPlaybackRecord,
  DesktopMotionTuningSample,
} from "../types/desktop";

const bridge = useDesktopBridge();

const legacyPlaybackRecords = computed(() =>
  bridge.state.snapshot.motionPlaybackRecords.filter(
    (record): record is DesktopMotionPlaybackRecord =>
      record.plan.schema_version === "engine.parameter_plan.v1",
  ),
);
const semanticPlaybackCount = computed(() =>
  bridge.state.snapshot.motionPlaybackRecords.filter(
    (record) => record.plan.schema_version === "engine.parameter_plan.v2",
  ).length,
);
const legacyTuningSamples = computed(() =>
  bridge.state.snapshot.motionTuningSamples.filter(
    (sample): sample is DesktopMotionTuningSample =>
      sample.adjustedPlan.schema_version === "engine.parameter_plan.v1",
  ),
);
const latestLegacyRecord = computed(() => legacyPlaybackRecords.value[0] ?? null);

function deleteSample(sampleId: string): void {
  bridge.sendCommand({
    type: "delete_motion_tuning_sample",
    sampleId,
  });
}

function formatRecordTime(record: { createdAt: string }): string {
  const date = new Date(record.createdAt);
  if (Number.isNaN(date.getTime())) {
    return record.createdAt;
  }
  return date.toLocaleTimeString();
}
</script>

<template>
  <article class="settings-card settings-card--wide motion-tuning">
    <div class="settings-card__header">
      <div>
        <p class="settings-card__eyebrow">遗留兼容</p>
        <h2>旧版 12 轴调参已停用</h2>
      </div>
      <span class="settings-card__badge">
        {{ legacyPlaybackRecords.length }} legacy / {{ legacyTuningSamples.length }} samples
      </span>
    </div>

    <p class="settings-card__copy">
      主链路已经切到动态主轴 `engine.parameter_plan.v2`。这个面板现在只保留遗留记录查看和样本清理，
      不再提供旧版 12 轴回放、手调或保存功能，避免和当前语义主轴工作流混淆。
    </p>

    <div class="settings-card__stack">
      <div>
        <span>当前主链路</span>
        <strong>
          {{
            semanticPlaybackCount
              ? `最近 ${semanticPlaybackCount} 条播放记录已使用动态主轴 v2`
              : "等待新的动态主轴播放记录"
          }}
        </strong>
      </div>
      <div>
        <span>遗留 v1 记录</span>
        <strong>{{ legacyPlaybackRecords.length ? `${legacyPlaybackRecords.length} 条` : "无" }}</strong>
      </div>
      <div>
        <span>遗留样本</span>
        <strong>{{ legacyTuningSamples.length ? `${legacyTuningSamples.length} 条` : "无" }}</strong>
      </div>
    </div>

    <p v-if="latestLegacyRecord" class="settings-card__hint">
      最近一条遗留记录：{{ latestLegacyRecord.emotionLabel }} ·
      {{ latestLegacyRecord.mode }} ·
      {{ formatRecordTime(latestLegacyRecord) }}。
      如需继续验证当前重构链路，请改用下方语义主轴编辑器和 Base Action 预览面板。
    </p>

    <details v-if="legacyTuningSamples.length" class="motion-tuning__details">
      <summary>查看并清理遗留样本</summary>
      <ul class="motion-tuning__sample-list">
        <li
          v-for="sample in legacyTuningSamples"
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
    </details>
  </article>
</template>
