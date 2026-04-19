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

const voiceLabel = computed(() => {
  if (bridge.state.snapshot.audioPlaying) {
    return "语音播放中";
  }
  if (bridge.state.snapshot.micRequested) {
    return "麦克风待命";
  }
  return "语音待接入";
});

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

      <header class="overlay-card__header">
        <div>
          <p class="overlay-card__eyebrow">Desktop Chat</p>
          <strong>{{ bridge.state.snapshot.selectedModelName || "AG99live" }}</strong>
        </div>
        <span class="overlay-card__badge" :data-state="bridge.state.snapshot.aiState">
          {{ aiStateLabel }}
        </span>
      </header>

      <p class="overlay-card__status">{{ previewText }}</p>

      <div class="overlay-card__toolbar">
        <span
          class="overlay-card__voice-pill"
          :data-active="bridge.state.snapshot.micRequested || bridge.state.snapshot.audioPlaying"
        >
          {{ voiceLabel }}
        </span>
        <button
          type="button"
          class="overlay-card__action"
          @click="handleInterrupt"
        >
          打断
        </button>
      </div>

      <div class="overlay-card__composer">
        <input
          v-model="draft"
          class="overlay-card__input"
          type="text"
          placeholder="直接和桌宠说话"
          @keydown="onEnter"
        />
        <button
          type="button"
          class="overlay-card__send"
          @click="handleSend"
        >
          发送
        </button>
      </div>
    </section>
  </main>
</template>
