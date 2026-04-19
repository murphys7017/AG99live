<script setup lang="ts">
import { computed, ref } from "vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";

const bridge = useDesktopBridge();
const draft = ref("");

const aiStateLabel = computed(() => {
  switch (bridge.state.snapshot.aiState) {
    case "connecting":
      return "连接中";
    case "thinking":
      return "思考中";
    case "speaking":
      return "播放中";
    case "listening":
      return "待收音";
    case "error":
      return "异常";
    case "idle":
      return "待命";
    default:
      return "离线";
  }
});

const previewText = computed(() => {
  if (bridge.state.snapshot.lastAssistantText.trim()) {
    return bridge.state.snapshot.lastAssistantText.trim();
  }
  return bridge.state.snapshot.connectionStatusMessage;
});

const voiceActive = computed(() =>
  bridge.state.snapshot.micRequested || bridge.state.snapshot.audioPlaying,
);

function handleSend(): void {
  const text = draft.value.trim();
  if (!text) {
    return;
  }

  bridge.sendCommand({ type: "send_text", text });
  draft.value = "";
}

function handleInterrupt(): void {
  bridge.sendCommand({ type: "interrupt" });
}

function showContextMenu(): void {
  window.ag99desktop?.showContextMenu();
}

function onEnter(event: KeyboardEvent): void {
  if (event.isComposing) {
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    handleSend();
  }
}
</script>

<template>
  <main
    class="desktop-shell desktop-shell--overlay"
    @contextmenu.prevent="showContextMenu"
  >
    <section class="overlay-card">
      <div class="overlay-card__grip" aria-hidden="true"></div>

      <p
        class="overlay-card__message"
        :data-empty="!previewText.trim()"
      >
        {{ previewText.trim() || "..." }}
      </p>

      <div class="overlay-card__status-row">
        <span class="overlay-card__status-label">{{ aiStateLabel }}</span>
        <div class="overlay-card__icon-group">
          <span
            class="overlay-card__icon-pill"
            :data-active="voiceActive"
            :title="voiceActive ? '语音链路活跃' : '语音链路待命'"
          >
            <svg
              class="overlay-card__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Z" />
              <path d="M19 11a7 7 0 0 1-14 0" />
              <path d="M12 18v4" />
              <path d="M8 22h8" />
            </svg>
          </span>
          <button
            type="button"
            class="overlay-card__icon-button"
            title="打断"
            @click="handleInterrupt"
          >
            <svg
              class="overlay-card__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="7" y="7" width="10" height="10" rx="2" />
            </svg>
          </button>
        </div>
      </div>

      <form class="overlay-card__composer" @submit.prevent="handleSend">
        <input
          v-model="draft"
          class="overlay-card__input"
          type="text"
          placeholder="直接和桌宠说话"
          @keydown="onEnter"
        />
        <button
          type="submit"
          class="overlay-card__send"
          aria-label="发送"
        >
          <svg
            class="overlay-card__icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 3 9 15" />
            <path d="m21 3-8.5 18-3.5-6-6-3.5L21 3Z" />
          </svg>
        </button>
      </form>
    </section>
  </main>
</template>
