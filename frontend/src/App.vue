<script setup lang="ts">
import { computed, ref } from "vue";
import PetControlDock from "./components/PetControlDock.vue";
import PetLaunchCard from "./components/PetLaunchCard.vue";
import PetStage from "./components/PetStage.vue";
import { useModelSync } from "./composables/useModelSync";

const { state, selectedModel } = useModelSync();

const draft = ref("");
const micEnabled = ref(false);
const lastSentText = ref("");

const hasModelSync = computed(() => Boolean(selectedModel.value));
const connectionState = computed(() => {
  if (hasModelSync.value) {
    return "synced";
  }
  if (state.sessionId) {
    return "linked";
  }
  return "first_launch";
});

const connectionLabel = computed(() => {
  if (connectionState.value === "synced") {
    return "已同步模型";
  }
  if (connectionState.value === "linked") {
    return "已连接适配器";
  }
  return "首次启动";
});

const stageMessage = computed(() => {
  if (lastSentText.value.trim()) {
    return `最近发送：${lastSentText.value.trim()}`;
  }
  if (selectedModel.value) {
    return `${selectedModel.value.name} 已准备好接收参数驱动。`;
  }
  return "等待 AstrBot 适配器同步模型能力。";
});

function handleSend() {
  const text = draft.value.trim();
  if (!text) {
    return;
  }
  lastSentText.value = text;
  draft.value = "";
}

function handleInterrupt() {
  draft.value = "";
}

function handleToggleMic() {
  micEnabled.value = !micEnabled.value;
}

function updateDraft(nextValue: string) {
  draft.value = nextValue;
}
</script>

<template>
  <main class="pet-page">
    <div class="pet-page__glow pet-page__glow--amber" aria-hidden="true"></div>
    <div class="pet-page__glow pet-page__glow--blue" aria-hidden="true"></div>
    <div class="pet-page__grain" aria-hidden="true"></div>

    <section class="pet-layout">
      <PetLaunchCard
        :selected-model="selectedModel"
        :session-id="state.sessionId"
        :conf-name="state.confName"
        :last-updated="state.lastUpdated"
        :connection-label="connectionLabel"
      />

      <PetStage
        :selected-model="selectedModel"
        :connection-label="connectionLabel"
        :stage-message="stageMessage"
        :last-sent-text="lastSentText"
      />

      <PetControlDock
        :draft="draft"
        :mic-enabled="micEnabled"
        :selected-model="selectedModel"
        :connection-state="connectionState"
        :connection-label="connectionLabel"
        :last-sent-text="lastSentText"
        @update:draft="updateDraft"
        @send="handleSend"
        @toggle-mic="handleToggleMic"
        @interrupt="handleInterrupt"
      />
    </section>
  </main>
</template>
