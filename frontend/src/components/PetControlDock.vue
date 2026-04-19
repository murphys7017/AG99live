<script setup lang="ts">
import { computed } from "vue";
import type { ModelSummary } from "../types/protocol";

const props = defineProps<{
  draft: string;
  micEnabled: boolean;
  selectedModel: ModelSummary | null;
  connectionState: string;
  connectionLabel: string;
  lastSentText: string;
}>();

const emit = defineEmits<{
  "update:draft": [value: string];
  send: [];
  "toggle-mic": [];
  interrupt: [];
}>();

const footerHint = computed(() => {
  if (props.connectionState === "first_launch") {
    return "等待首个 model sync。";
  }
  if (props.connectionState === "linked") {
    return "适配器已连通，等待模型能力同步。";
  }
  return "Pet 控件层可继续接入输入、麦克风和中断链路。";
});

function onEnter(event: KeyboardEvent) {
  if (event.isComposing) {
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    emit("send");
  }
}
</script>

<template>
  <section class="control-dock glass-panel">
    <div class="control-dock__header">
      <div>
        <span class="control-dock__eyebrow">Pet Controls</span>
        <h2>{{ connectionLabel }}</h2>
      </div>
      <span class="control-dock__badge">
        {{ selectedModel?.engine_hints.recommended_mode ?? "await-sync" }}
      </span>
    </div>

    <div class="control-dock__status">
      <div class="control-dock__status-item">
        <span>麦克风</span>
        <strong>{{ micEnabled ? "开启" : "关闭" }}</strong>
      </div>
      <div class="control-dock__status-item">
        <span>主模型</span>
        <strong>{{ selectedModel?.name ?? "暂无" }}</strong>
      </div>
      <div class="control-dock__status-item">
        <span>表达层</span>
        <strong>{{ selectedModel?.constraints.expressions.length ?? 0 }}</strong>
      </div>
    </div>

    <div class="control-dock__message">
      <p class="control-dock__message-label">最近消息</p>
      <p class="control-dock__message-text">
        {{ lastSentText || "这里会保留最近一次用户输入或后端返回的简短内容。" }}
      </p>
    </div>

    <div class="control-dock__actions">
      <button
        type="button"
        class="control-button control-button--ghost"
        @click="$emit('toggle-mic')"
      >
        {{ micEnabled ? "关闭麦克风" : "打开麦克风" }}
      </button>
      <button
        type="button"
        class="control-button control-button--ghost"
        @click="$emit('interrupt')"
      >
        中断
      </button>
    </div>

    <div class="control-dock__composer">
      <textarea
        :value="draft"
        class="control-dock__input"
        rows="3"
        placeholder="在 Pet 模式里直接输入给角色的话。"
        @input="$emit('update:draft', ($event.target as HTMLTextAreaElement).value)"
        @keydown="onEnter"
      ></textarea>

      <button
        type="button"
        class="control-button control-button--primary"
        @click="$emit('send')"
      >
        发送到桌宠
      </button>
    </div>

    <p class="control-dock__hint">{{ footerHint }}</p>
  </section>
</template>
