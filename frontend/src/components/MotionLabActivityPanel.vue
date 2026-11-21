<script setup lang="ts">
import { computed, ref } from "vue";
import { readMotionLabPreview, type MotionLabPreview, type MotionLabRawEvent } from "../types/motionLab.js";

const props = defineProps<{
  events: readonly MotionLabRawEvent[];
  status?: string;
  canPreview: boolean;
  previewPending: boolean;
  previewStatus: string;
}>();

const emit = defineEmits<{ preview: [preview: MotionLabPreview] }>();
const search = ref("");
const kind = ref("all");
const playbackStatus = ref("");

type MotionRun = {
  runId: string;
  turnId: string;
  messageId: string;
  emotionLabel: string;
  source: string;
  details: string;
  startedAt: string;
  assistantText: string;
  status: "playing" | "completed" | "failed" | "stopped";
  reason: string;
};

type MotionSegment = {
  key: string;
  turnId: string;
  messageId: string;
  segmentIndex: number;
  segmentCount: number;
  ambient: boolean;
  emotionLabel: string;
  source: string;
  details: string;
  assistantText: string;
  status: string;
  latestEventType: string;
  createdAt: string;
  eventCount: number;
  preview: MotionLabPreview | null;
};

const motionEvents = computed(() => props.events
  .filter((event) => event.event_type.startsWith("motion.") || event.event_type.startsWith("ambient."))
  .sort((left, right) => left.created_at.localeCompare(right.created_at)));

const activeRuns = computed<MotionRun[]>(() => {
  const runs = new Map<string, MotionRun>();
  for (const event of motionEvents.value) {
    const raw = event.raw ?? {};
    const record = asRecord(raw.record);
    const runId = stringValue(event.run_id)
      || stringValue(raw.runId)
      || stringValue(raw.actionId)
      || stringValue(record?.runId);
    if (!runId) continue;
    if (event.event_type === "ambient.action_started") {
      runs.set(runId, {
        runId,
        turnId: "环境动作",
        messageId: stringValue(raw.actionId) || stringValue(event.message_id),
        emotionLabel: stringValue(raw.emotionLabel) || "环境动作",
        source: stringValue(event.source_route) || "ambient",
        details: ambientDetails(raw),
        startedAt: event.created_at,
        assistantText: "",
        status: "playing",
        reason: "",
      });
      continue;
    }
    if (event.event_type === "ambient.action_released" || event.event_type === "ambient.action_rejected") {
      const current = runs.get(runId);
      if (!current) continue;
      current.status = event.event_type === "ambient.action_released" ? "completed" : "failed";
      current.reason = stringValue(raw.reason);
      continue;
    }
    if (event.event_type === "motion.playback_started") {
      runs.set(runId, {
        runId,
        turnId: stringValue(event.turn_id),
        messageId: stringValue(event.message_id),
        emotionLabel: stringValue(record?.emotionLabel) || "动作",
        source: stringValue(event.source_route) || "motion",
        details: "",
        startedAt: event.created_at,
        assistantText: stringValue(event.assistant_text)
          || stringValue(record?.assistantText),
        status: "playing",
        reason: "",
      });
      continue;
    }
    if (!event.event_type.startsWith("motion.playback_")) continue;
    const current = runs.get(runId);
    if (!current) continue;
    const rawStatus = stringValue(raw.status);
    current.status = event.event_type === "motion.playback_completed"
      ? "completed"
      : rawStatus === "stopped" ? "stopped" : "failed";
    current.reason = stringValue(raw.reason);
  }
  return [...runs.values()].filter((run) => run.status === "playing").reverse();
});

const segments = computed<MotionSegment[]>(() => {
  const groups = new Map<string, {
    turnId: string;
    messageId: string;
    ambient: boolean;
    segmentIndex: number | null;
    segmentCount: number | null;
    emotionLabel: string;
    source: string;
    details: string;
    assistantText: string;
    status: string;
    latestEventType: string;
    createdAt: string;
    eventCount: number;
    preview: MotionLabPreview | null;
  }>();
  for (const event of motionEvents.value) {
    const raw = event.raw ?? {};
    const record = asRecord(raw.record);
    const ambient = event.event_type.startsWith("ambient.");
    const turnId = ambient ? "环境动作" : stringValue(event.turn_id) || "无 turn";
    const messageId = ambient
      ? stringValue(raw.actionId) || stringValue(event.message_id) || "无 action"
      : stringValue(event.message_id) || "无 segment";
    const key = ambient
      ? `ambient\u0000${messageId}`
      : `${turnId}\u0000${messageId}`;
    const segmentIndex = numberValue(raw.segmentIndex) ?? numberValue(raw.segment_index);
    const segmentCount = numberValue(raw.segmentCount) ?? numberValue(raw.segment_count);
    const current = groups.get(key) ?? {
      turnId,
      messageId,
      ambient,
      segmentIndex,
      segmentCount,
      emotionLabel: stringValue(record?.emotionLabel) || "动作",
      source: stringValue(event.source_route) || "motion",
      details: ambient ? ambientDetails(raw) : "",
      assistantText: stringValue(event.assistant_text) || stringValue(record?.assistantText),
      status: "已生成",
      latestEventType: event.event_type,
      createdAt: event.created_at,
      eventCount: 0,
      preview: null,
    };
    current.eventCount += 1;
    if (event.event_type === "motion.playback_started" || event.event_type === "ambient.action_started") {
      current.preview = readMotionLabPreview(raw) ?? current.preview;
      current.source = stringValue(event.source_route) || current.source;
      current.emotionLabel = stringValue(record?.emotionLabel) || stringValue(raw.emotionLabel) || current.emotionLabel;
    }
    current.latestEventType = event.event_type;
    current.createdAt = event.created_at;
    current.assistantText ||= stringValue(event.assistant_text) || stringValue(record?.assistantText);
    current.emotionLabel ||= stringValue(record?.emotionLabel) || "动作";
    current.segmentIndex = segmentIndex ?? current.segmentIndex;
    current.segmentCount = segmentCount ?? current.segmentCount;
    current.details ||= ambientDetails(raw);
    if (event.event_type === "motion.playback_started") current.status = "播放中";
    if (event.event_type === "motion.playback_completed") current.status = "已完成";
    if (event.event_type === "motion.playback_failed") current.status = "失败";
    if (event.event_type === "ambient.action_started") current.status = "播放中";
    if (event.event_type === "ambient.action_released") current.status = "已完成";
    if (event.event_type === "ambient.action_rejected") current.status = "未执行";
    groups.set(key, current);
  }

  const byTurn = new Map<string, Array<[string, typeof groups extends Map<string, infer T> ? T : never]>>();
  for (const [key, group] of groups) {
    const list = byTurn.get(group.turnId) ?? [];
    list.push([key, group]);
    byTurn.set(group.turnId, list);
  }
  const indexed: MotionSegment[] = [];
  for (const [turnId, list] of byTurn) {
    list.sort((left, right) => left[1].createdAt.localeCompare(right[1].createdAt));
    const authoritativeCount = Math.max(
      list.length,
      ...list.map(([, group]) => group.segmentCount ?? 0),
    );
    list.forEach(([key, group], index) => {
      indexed.push({
        ...group,
        key,
        turnId,
        segmentIndex: group.ambient ? 1 : group.segmentIndex ?? index + 1,
        segmentCount: group.ambient
          ? 1
          : Math.max(group.segmentCount ?? 0, authoritativeCount),
      });
    });
  }
  return indexed.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
});

const filteredSegments = computed(() => {
  const query = search.value.trim().toLowerCase();
  return segments.value.filter((segment) => {
    if (kind.value === "ambient" && !segment.ambient) return false;
    if (kind.value === "dialogue" && segment.ambient) return false;
    if (kind.value === "playable" && !segment.preview) return false;
    if (playbackStatus.value && segment.status !== playbackStatus.value) return false;
    return !query || [
      segment.emotionLabel, segment.assistantText, segment.source,
      segment.details, segment.messageId, segment.turnId,
    ].some((value) => value.toLowerCase().includes(query));
  }).slice(0, 30);
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function ambientDetails(raw: Record<string, unknown>): string {
  const metadata = asRecord(raw.metadata);
  if (!metadata) return "";
  const recipeId = stringValue(metadata.recipeId);
  const templateId = stringValue(metadata.templateId);
  const fragments = Array.isArray(metadata.fragmentIds)
    ? metadata.fragmentIds.filter((value): value is string => typeof value === "string").length
    : 0;
  const atoms = Array.isArray(metadata.atomIds)
    ? metadata.atomIds.filter((value): value is string => typeof value === "string").length
    : 0;
  const labels = [
    recipeId ? `配方 ${recipeId}` : "",
    templateId ? `模板 ${templateId}` : "",
    fragments ? `${fragments} fragments` : "",
    atoms ? `${atoms} atoms` : "",
  ].filter(Boolean);
  return labels.join(" · ");
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleTimeString()
    : value;
}
</script>

<template>
  <article class="motion-activity settings-card settings-card--wide">
    <div class="settings-card__header">
      <div>
        <p class="settings-card__eyebrow">实时执行与历史</p>
        <h2>动作执行流</h2>
      </div>
      <span class="settings-card__badge">{{ motionEvents.length }} events</span>
    </div>
    <p v-if="status" class="settings-card__hint">{{ status }}</p>

    <section class="motion-activity__current">
      <div class="motion-activity__section-title">
        <strong>当前执行</strong>
        <span>{{ activeRuns.length }} active</span>
      </div>
      <div v-if="activeRuns.length" class="motion-activity__active-list">
        <article v-for="run in activeRuns" :key="run.runId" class="motion-activity__active-item">
          <span class="motion-activity__pulse"></span>
          <div>
            <strong>{{ run.emotionLabel }}</strong>
            <small>{{ run.source }} · {{ run.messageId || "无 segment" }}</small>
            <small v-if="run.details">{{ run.details }}</small>
          </div>
          <time>{{ formatTime(run.startedAt) }}</time>
        </article>
      </div>
      <p v-else class="motion-activity__empty">当前没有正在播放的动作。</p>
    </section>

    <section class="motion-activity__history">
      <div class="motion-activity__section-title">
        <strong>动作历史</strong>
      </div>
      <div class="motion-activity__filters">
        <input v-model="search" type="search" aria-label="搜索动作" placeholder="搜索动作、台词或来源" />
        <select v-model="kind" aria-label="动作类型">
          <option value="all">全部类型</option>
          <option value="dialogue">对话动作</option>
          <option value="ambient">环境动作</option>
          <option value="playable">可重放</option>
        </select>
        <select v-model="playbackStatus" aria-label="播放状态">
          <option value="">全部状态</option>
          <option v-for="value in ['已生成', '播放中', '已完成', '失败', '未执行']" :key="value" :value="value">
            {{ value }}
          </option>
        </select>
      </div>
      <p v-if="previewStatus" class="settings-card__hint" role="status">{{ previewStatus }}</p>
      <div v-if="filteredSegments.length" class="motion-activity__segment-list">
        <article v-for="segment in filteredSegments" :key="segment.key" class="motion-activity__segment">
          <div class="motion-activity__segment-header">
            <strong>{{ segment.ambient ? "环境 · " : "" }}{{ segment.emotionLabel }}</strong>
            <div class="motion-activity__segment-actions">
              <span :data-status="segment.status">{{ segment.status }}</span>
              <button
                v-if="segment.preview"
                type="button"
                class="web-control-refresh"
                :aria-label="`播放${segment.emotionLabel}`"
                :disabled="!canPreview || previewPending"
                @click="emit('preview', segment.preview)"
              >播放</button>
            </div>
          </div>
          <p>{{ segment.assistantText || (segment.ambient ? "待机或环境反应动作" : "暂无助手文本") }}</p>
          <small>
            {{ segment.turnId }} · {{ segment.ambient ? "环境动作" : "第 " + segment.segmentIndex + "/" + segment.segmentCount + " 段" }} ·
            {{ segment.messageId }} · {{ segment.source }} · {{ formatTime(segment.createdAt) }} ·
            {{ segment.eventCount }} events
          </small>
          <small v-if="segment.details" class="motion-activity__segment-details">{{ segment.details }}</small>
        </article>
      </div>
      <p v-else class="motion-activity__empty">
        {{ segments.length ? "没有符合筛选条件的动作。" : "还没有收到动作事件。" }}
      </p>
    </section>
  </article>
</template>

<style scoped>
.motion-activity__filters,
.motion-activity__segment-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.motion-activity__filters {
  margin-bottom: 12px;
}

.motion-activity__filters input,
.motion-activity__filters select {
  min-height: 34px;
  padding: 5px 9px;
  border: 1px solid #465052;
  border-radius: 6px;
  color: inherit;
  background: #202628;
}

.motion-activity__section-title {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
  color: #cbd5e1;
}

.motion-activity__section-title span,
.motion-activity__empty,
.motion-activity__segment small,
.motion-activity__active-item small,
.motion-activity__active-item time {
  color: #94a3b8;
  font-size: 12px;
}

.motion-activity__current,
.motion-activity__history {
  margin-top: 16px;
}

.motion-activity__active-list,
.motion-activity__segment-list {
  display: grid;
  gap: 8px;
}

.motion-activity__active-item,
.motion-activity__segment {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 10px;
  padding: 11px 13px;
  background: rgba(15, 23, 42, 0.38);
}

.motion-activity__active-item {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
}

.motion-activity__active-item div {
  display: grid;
  gap: 3px;
}

.motion-activity__pulse {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 0 5px rgba(52, 211, 153, 0.12);
}

.motion-activity__segment-header {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.motion-activity__segment-header span {
  color: #a7f3d0;
  font-size: 12px;
}

.motion-activity__segment-header span[data-status="失败"] {
  color: #fda4af;
}

.motion-activity__segment p {
  margin: 7px 0;
  color: #cbd5e1;
  line-height: 1.5;
}

.motion-activity__segment-details {
  display: block;
  margin-top: 4px;
  color: #a5b4fc;
}

.motion-activity__empty {
  margin: 0;
}
</style>
