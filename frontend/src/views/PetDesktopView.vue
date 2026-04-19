<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import DesktopPetCanvas from "../components/DesktopPetCanvas.vue";
import { useAdapterConnection } from "../composables/useAdapterConnection";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import { useModelSync } from "../composables/useModelSync";
import type { DesktopRuntimeCommand } from "../types/desktop";

const { state, selectedModel } = useModelSync();
const adapter = useAdapterConnection();
const bridge = useDesktopBridge();

const connectionState = computed(() => {
  if (adapter.state.status === "connecting") {
    return "connecting";
  }
  if (adapter.state.status === "error") {
    return "error";
  }
  if (selectedModel.value) {
    return "synced";
  }
  if (adapter.state.status === "connected") {
    return "linked";
  }
  return "disconnected";
});

const connectionLabel = computed(() => {
  if (connectionState.value === "synced") {
    return "已同步模型";
  }
  if (connectionState.value === "connecting") {
    return "连接中";
  }
  if (connectionState.value === "error") {
    return "连接异常";
  }
  if (connectionState.value === "linked") {
    return "已连接适配器";
  }
  return "未连接";
});

const stageMessage = computed(() => {
  if (adapter.state.lastAssistantText.trim()) {
    return adapter.state.lastAssistantText.trim();
  }
  if (adapter.state.lastError.trim()) {
    return adapter.state.lastError.trim();
  }
  if (selectedModel.value) {
    return `${selectedModel.value.name} 已进入桌宠待命状态。`;
  }
  return adapter.state.statusMessage;
});

const aiState = computed(() => {
  if (adapter.state.status === "connecting") {
    return "connecting";
  }
  if (adapter.state.status === "error") {
    return "error";
  }
  if (adapter.state.currentTurnId && adapter.state.isPlayingAudio) {
    return "speaking";
  }
  if (adapter.state.currentTurnId) {
    return "thinking";
  }
  if (adapter.state.micRequested) {
    return "listening";
  }
  if (adapter.state.status === "connected" || selectedModel.value) {
    return "idle";
  }
  return "offline";
});

function handleDesktopCommand(command: DesktopRuntimeCommand): void {
  switch (command.type) {
    case "set_address":
      adapter.setAddress(command.address);
      return;
    case "connect":
      if (typeof command.address === "string") {
        adapter.setAddress(command.address);
      }
      adapter.connect();
      return;
    case "disconnect":
      adapter.disconnect();
      return;
    case "send_text":
      adapter.sendText(command.text);
      return;
    case "interrupt":
      adapter.interruptCurrentTurn();
      return;
  }
}

function showContextMenu(): void {
  window.ag99desktop?.showContextMenu();
}

const detachBridgeListener = bridge.onCommand(handleDesktopCommand);

watch(
  () => [
    adapter.state.address,
    adapter.state.status,
    adapter.state.statusMessage,
    adapter.state.sessionId,
    adapter.state.serverInfo?.ws_url ?? "",
    adapter.state.serverInfo?.http_base_url ?? "",
    adapter.state.lastAssistantText,
    adapter.state.lastTranscription,
    adapter.state.lastImageCount,
    adapter.state.currentTurnId,
    adapter.state.micRequested,
    adapter.state.isPlayingAudio,
    adapter.state.historyEntries,
    state.confName,
    state.lastUpdated,
    selectedModel.value?.name ?? "",
    selectedModel.value?.icon_url ?? "",
    selectedModel.value?.engine_hints.recommended_mode ?? "",
    stageMessage.value,
  ],
  () => {
    bridge.publishSnapshot({
      adapterAddress: adapter.state.address,
      connectionState: connectionState.value,
      connectionLabel: connectionLabel.value,
      connectionStatusMessage: adapter.state.statusMessage,
      aiState: aiState.value,
      micRequested: adapter.state.micRequested,
      audioPlaying: adapter.state.isPlayingAudio,
      sessionId: adapter.state.sessionId || state.sessionId,
      confName: state.confName,
      lastUpdated: state.lastUpdated,
      selectedModelName: selectedModel.value?.name ?? "",
      selectedModelIconUrl: selectedModel.value?.icon_url ?? "",
      recommendedMode:
        selectedModel.value?.engine_hints.recommended_mode ?? "",
      serverWsUrl: adapter.state.serverInfo?.ws_url ?? "",
      httpBaseUrl: adapter.state.serverInfo?.http_base_url ?? "",
      stageMessage: stageMessage.value,
      lastSentText: adapter.state.historyEntries
        .slice()
        .reverse()
        .find((entry) => entry.role === "user")?.text ?? "",
      lastAssistantText: adapter.state.lastAssistantText,
      lastTranscription: adapter.state.lastTranscription,
      lastImageCount: adapter.state.lastImageCount,
      historyEntries: [...adapter.state.historyEntries],
    });
  },
  { deep: true, immediate: true },
);

onMounted(async () => {
  await adapter.initialize();
  adapter.connect();
});

onBeforeUnmount(() => {
  detachBridgeListener();
});
</script>

<template>
  <main
    class="desktop-shell desktop-shell--pet"
    @contextmenu.prevent="showContextMenu"
  >
    <DesktopPetCanvas
      :selected-model="selectedModel"
      :status-text="connectionLabel"
      :stage-message="stageMessage"
    />
  </main>
</template>
