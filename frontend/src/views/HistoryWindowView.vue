<script setup lang="ts">
import { computed, watch } from "vue";
import DesktopWindowPanel from "../components/DesktopWindowPanel.vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
} from "../types/desktop";

const bridge = useDesktopBridge();

const connectionReady = computed(() =>
  bridge.state.snapshot.connectionState === "linked"
  || bridge.state.snapshot.connectionState === "synced",
);
const historySummaries = computed(() => bridge.state.snapshot.backendHistorySummaries);
const activeHistoryUid = computed(() => bridge.state.snapshot.activeBackendHistoryUid);
const entries = computed(() => [...bridge.state.snapshot.backendHistoryEntries].reverse());
const statusMessage = computed(() => bridge.state.snapshot.backendHistoryStatusMessage.trim());

watch(
  connectionReady,
  (ready, wasReady) => {
    if (!ready || ready === wasReady) {
      return;
    }
    refreshHistory(false);
  },
  { immediate: true },
);

const emptyLabel = computed(() => {
  if (bridge.state.snapshot.connectionState === "disconnected") {
    return "桌宠窗口还没有连上后端，所以暂时无法读取真实历史。";
  }
  if (bridge.state.snapshot.backendHistoryLoading) {
    return "正在从后端加载对话历史。";
  }
  if (statusMessage.value) {
    return statusMessage.value;
  }
  return "等待后端返回第一段真实会话历史。";
});

function formatTimestamp(timestamp: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  } catch (_error) {
    return timestamp;
  }
}

function refreshHistory(announce = true): void {
  bridge.sendCommand({ type: "request_history_list" });
  if (!announce) {
    return;
  }
}

function createHistory(): void {
  bridge.sendCommand({ type: "create_history" });
}

function loadHistory(historyUid: string): void {
  bridge.sendCommand({ type: "load_history", historyUid });
}

function deleteCurrentHistory(): void {
  if (!activeHistoryUid.value) {
    return;
  }
  bridge.sendCommand({ type: "delete_history", historyUid: activeHistoryUid.value });
}

function formatSummaryLabel(summary: DesktopBackendHistorySummary, index: number): string {
  if (summary.uid === activeHistoryUid.value) {
    return `当前会话 ${index + 1}`;
  }
  return `历史会话 ${index + 1}`;
}

function summarizeHistory(summary: DesktopBackendHistorySummary): string {
  const preview = summary.latestMessage?.content.trim();
  if (preview) {
    return preview;
  }
  return `空白会话 · ${summary.uid}`;
}

function entryRole(entry: DesktopBackendHistoryMessage): "user" | "assistant" | "system" {
  if (entry.type === "tool_call_status") {
    return "system";
  }
  if (entry.role === "human") {
    return "user";
  }
  if (entry.role === "ai") {
    return "assistant";
  }
  return "system";
}

function entryLabel(entry: DesktopBackendHistoryMessage): string {
  if (entry.type === "tool_call_status") {
    return entry.toolName ? `tool:${entry.toolName}` : "tool";
  }
  if (entry.role === "human") {
    return "user";
  }
  if (entry.role === "ai") {
    return entry.name?.trim() || "assistant";
  }
  return "system";
}
</script>

<template>
  <DesktopWindowPanel title="对话历史" subtitle="Backend Conversation History">
    <section class="pet-window__toolbar no-drag">
      <button
        type="button"
        class="control-button control-button--inline"
        @click="refreshHistory()"
      >
        刷新
      </button>
      <button
        type="button"
        class="control-button control-button--inline"
        @click="createHistory"
      >
        新建会话
      </button>
      <button
        type="button"
        class="control-button control-button--inline"
        :disabled="!activeHistoryUid"
        @click="deleteCurrentHistory"
      >
        删除当前
      </button>
    </section>

    <section v-if="historySummaries.length" class="history-list">
      <article
        v-for="(summary, index) in historySummaries"
        :key="summary.uid"
        class="history-item"
        :data-role="summary.latestMessage?.role === 'human' ? 'user' : 'assistant'"
      >
        <header class="history-item__header">
          <strong>{{ formatSummaryLabel(summary, index) }}</strong>
          <span>{{ formatTimestamp(summary.timestamp) }}</span>
        </header>
        <p>{{ summarizeHistory(summary) }}</p>
        <button
          type="button"
          class="control-button control-button--inline"
          :disabled="summary.uid === activeHistoryUid"
          @click="loadHistory(summary.uid)"
        >
          {{ summary.uid === activeHistoryUid ? "已载入" : "载入" }}
        </button>
      </article>
    </section>

    <section class="history-list">
      <article
        v-for="entry in entries"
        :key="entry.id"
        class="history-item"
        :data-role="entryRole(entry)"
      >
        <header class="history-item__header">
          <strong>{{ entryLabel(entry) }}</strong>
          <span>{{ formatTimestamp(entry.timestamp) }}</span>
        </header>
        <p>{{ entry.content }}</p>
      </article>

      <div v-if="!entries.length" class="history-empty">
        {{ emptyLabel }}
      </div>
    </section>
  </DesktopWindowPanel>
</template>
