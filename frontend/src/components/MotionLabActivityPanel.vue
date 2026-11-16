<script setup lang="ts">
import { computed } from "vue";
import type { MotionLabRawEvent } from "../types/motionLab.js";

const props = defineProps<{
  events: readonly MotionLabRawEvent[];
  status?: string;
}>();

type MotionRun = {
  runId: string;
  turnId: string;
  messageId: string;
  emotionLabel: string;
  source: string;
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
  emotionLabel: string;
  source: string;
  assistantText: string;
  status: string;
  latestEventType: string;
  createdAt: string;
  eventCount: number;
};

const motionEvents = computed(() => props.events
  .filter((event) => event.event_type.startsWith("motion."))
  .sort((left, right) => left.created_at.localeCompare(right.created_at)));

const activeRuns = computed<MotionRun[]>(() => {
  const runs = new Map<string, MotionRun>();
  for (const event of motionEvents.value) {
    const raw = event.raw ?? {};
    const record = asRecord(raw.record);
    const runId = stringValue(event.run_id)
      || stringValue(raw.runId)
      || stringValue(record?.runId);
    if (!runId) continue;
    if (event.event_type === "motion.playback_started") {
      runs.set(runId, {
        runId,
        turnId: stringValue(event.turn_id),
        messageId: stringValue(event.message_id),
        emotionLabel: stringValue(record?.emotionLabel) || "动作",
        source: stringValue(event.source_route) || "motion",
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
    emotionLabel: string;
    source: string;
    assistantText: string;
    status: string;
    latestEventType: string;
    createdAt: string;
    eventCount: number;
  }>();
  for (const event of motionEvents.value) {
    const turnId = stringValue(event.turn_id) || "无 turn";
    const messageId = stringValue(event.message_id) || "无 segment";
    const key = `${turnId}\u0000${messageId}`;
    const raw = event.raw ?? {};
    const record = asRecord(raw.record);
    const current = groups.get(key) ?? {
      turnId,
      messageId,
      emotionLabel: stringValue(record?.emotionLabel) || "动作",
      source: stringValue(event.source_route) || "motion",
      assistantText: stringValue(event.assistant_text) || stringValue(record?.assistantText),
      status: "已生成",
      latestEventType: event.event_type,
      createdAt: event.created_at,
      eventCount: 0,
    };
    current.eventCount += 1;
    current.latestEventType = event.event_type;
    current.createdAt = event.created_at;
    current.assistantText ||= stringValue(event.assistant_text) || stringValue(record?.assistantText);
    current.emotionLabel ||= stringValue(record?.emotionLabel) || "动作";
    if (event.event_type === "motion.playback_started") current.status = "播放中";
    if (event.event_type === "motion.playback_completed") current.status = "已完成";
    if (event.event_type === "motion.playback_failed") current.status = "失败";
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
    list.forEach(([key, group], index) => {
      indexed.push({ ...group, key, turnId, segmentIndex: index + 1, segmentCount: list.length });
    });
  }
  return indexed.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 30);
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
          </div>
          <time>{{ formatTime(run.startedAt) }}</time>
        </article>
      </div>
      <p v-else class="motion-activity__empty">当前没有正在播放的动作。</p>
    </section>

    <section class="motion-activity__history">
      <div class="motion-activity__section-title">
        <strong>消息动作历史</strong>
        <span>按 turn / segment 分组</span>
      </div>
      <div v-if="segments.length" class="motion-activity__segment-list">
        <article v-for="segment in segments" :key="segment.key" class="motion-activity__segment">
          <div class="motion-activity__segment-header">
            <strong>{{ segment.emotionLabel }}</strong>
            <span :data-status="segment.status">{{ segment.status }}</span>
          </div>
          <p>{{ segment.assistantText || "暂无助手文本" }}</p>
          <small>
            {{ segment.turnId }} · 第 {{ segment.segmentIndex }}/{{ segment.segmentCount }} 段 ·
            {{ segment.messageId }} · {{ segment.source }} · {{ formatTime(segment.createdAt) }} ·
            {{ segment.eventCount }} events
          </small>
        </article>
      </div>
      <p v-else class="motion-activity__empty">还没有收到动作事件。</p>
    </section>
  </article>
</template>

<style scoped>
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

.motion-activity__empty {
  margin: 0;
}
</style>
