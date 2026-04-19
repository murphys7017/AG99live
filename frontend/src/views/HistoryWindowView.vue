<script setup lang="ts">
import { computed } from "vue";
import DesktopWindowPanel from "../components/DesktopWindowPanel.vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";

const bridge = useDesktopBridge();

const entries = computed(() => [...bridge.state.snapshot.historyEntries].reverse());

const emptyLabel = computed(() => {
  if (bridge.state.snapshot.connectionState === "disconnected") {
    return "桌宠窗口还没有连上后端，所以暂时没有可展示的消息。";
  }
  return "等待第一轮真实对话写入历史。";
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
</script>

<template>
  <DesktopWindowPanel title="对话历史" subtitle="Pet Runtime Mirror">
    <section class="history-list">
      <article
        v-for="entry in entries"
        :key="entry.id"
        class="history-item"
        :data-role="entry.role"
      >
        <header class="history-item__header">
          <strong>{{ entry.role }}</strong>
          <span>{{ formatTimestamp(entry.timestamp) }}</span>
        </header>
        <p>{{ entry.text }}</p>
      </article>

      <div v-if="!entries.length" class="history-empty">
        {{ emptyLabel }}
      </div>
    </section>
  </DesktopWindowPanel>
</template>
