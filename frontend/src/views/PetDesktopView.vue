<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import DesktopPetCanvas from "../components/DesktopPetCanvas.vue";
import { useAdapterConnection } from "../composables/useAdapterConnection";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import { useModelSync } from "../composables/useModelSync";
import { usePreviewMotionPlayer } from "../composables/usePreviewMotionPlayer";
import type { DesktopRuntimeCommand } from "../types/desktop";
import type { DesktopBaseActionPreview } from "../types/desktop";

const { state, selectedModel } = useModelSync();
const adapter = useAdapterConnection();
const bridge = useDesktopBridge();
const motionPlayer = usePreviewMotionPlayer();

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
  if (adapter.state.micCapturing) {
    return "listening";
  }
  if (adapter.state.status === "connected" || selectedModel.value) {
    return "idle";
  }
  return "offline";
});

const baseActionPreview = computed<DesktopBaseActionPreview | null>(() => {
  const model = selectedModel.value;
  const library = model?.base_action_library;
  if (!library) {
    return null;
  }

  return {
    schemaVersion: library.schema_version,
    extractionMode: library.extraction_mode,
    focusChannels: [...library.focus_channels],
    focusDomains: [...library.focus_domains],
    ignoredDomains: [...library.ignored_domains],
    summary: {
      motionCount: library.summary.motion_count,
      availableChannelCount: library.summary.available_channel_count,
      selectedChannelCount: library.summary.selected_channel_count,
      candidateComponentCount: library.summary.candidate_component_count,
      selectedAtomCount: library.summary.selected_atom_count,
      familyCount: library.summary.family_count,
    },
    analysis: {
      status: library.analysis.status,
      mode: library.analysis.mode,
      providerId: library.analysis.provider_id,
      inputSignature: library.analysis.input_signature ?? "",
      latencyMs: library.analysis.latency_ms ?? 0,
      cacheHit: library.analysis.cache_hit ?? false,
      selectedChannelCount: library.analysis.selected_channel_count ?? 0,
      error: library.analysis.error ?? "",
      fallbackReason: library.analysis.fallback_reason ?? "",
    },
    families: library.families.map((family) => ({
      name: family.name,
      label: family.label,
      channels: [...family.channels],
      atomCount: family.atom_count,
    })),
    channels: library.channels.map((channel) => ({
      name: channel.name,
      label: channel.label,
      family: channel.family,
      familyLabel: channel.family_label,
      domain: channel.domain,
      available: channel.available,
      candidateComponentCount: channel.candidate_component_count,
      selectedAtomCount: channel.selected_atom_count,
      polarityModes: [...channel.polarity_modes],
      atomIds: [...channel.atom_ids],
    })),
    atoms: library.atoms
      .map((atom) => ({
        id: atom.id,
        name: atom.name,
        label: atom.label,
        channel: atom.channel,
        channelLabel: atom.channel_label,
        family: atom.family,
        familyLabel: atom.family_label,
        domain: atom.domain,
        polarity: atom.polarity,
        semanticPolarity: atom.semantic_polarity,
        trait: atom.trait,
        strength: atom.strength,
        score: atom.score,
        energyScore: atom.energy_score,
        primaryParameterMatch: atom.primary_parameter_match,
        channelPurity: atom.channel_purity,
        sourceMotion: atom.source_motion,
        sourceFile: atom.source_file,
        sourceGroup: atom.source_group,
        sourceCategory: atom.source_category,
        sourceTags: [...atom.source_tags],
        duration: atom.duration,
        fps: atom.fps,
        loop: atom.loop,
        intensity: atom.intensity,
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (right.energyScore !== left.energyScore) {
          return right.energyScore - left.energyScore;
        }
        return left.id.localeCompare(right.id);
      }),
  };
});

function handlePreviewMotionPlan(plan: unknown): void {
  const localPlayed = motionPlayer.playPlan(plan, selectedModel.value);
  if (!localPlayed) {
    console.warn("[AG99live] Local motion preview playback failed to start.");
  }
  adapter.sendMotionPlanPreview(plan);
}

function handleDesktopCommand(command: DesktopRuntimeCommand): void {
  switch (command.type) {
    case "set_address":
      adapter.setAddress(command.address);
      return;
    case "set_desktop_screenshot_on_send":
      adapter.setDesktopScreenshotOnSendEnabled(command.enabled);
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
      void adapter.sendText(command.text);
      return;
    case "interrupt":
      motionPlayer.stopPlan("interrupted");
      adapter.interruptCurrentTurn();
      return;
    case "toggle_mic_capture":
      void adapter.toggleMicrophoneCapture();
      return;
    case "preview_motion_plan":
      handlePreviewMotionPlan(command.plan);
      return;
  }
}

function showContextMenu(event: MouseEvent): void {
  window.ag99desktop?.showContextMenu({
    x: event.clientX,
    y: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
  });
}

const detachBridgeListener = bridge.onCommand(handleDesktopCommand);

watch(
  () => [
    adapter.state.address,
    adapter.state.desktopScreenshotOnSendEnabled,
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
    adapter.state.micCapturing,
    adapter.state.isPlayingAudio,
    adapter.state.historyEntries,
    state.confName,
    state.lastUpdated,
    selectedModel.value?.name ?? "",
    selectedModel.value?.icon_url ?? "",
    selectedModel.value?.engine_hints.recommended_mode ?? "",
    baseActionPreview.value,
    stageMessage.value,
  ],
  () => {
    bridge.publishSnapshot({
      adapterAddress: adapter.state.address,
      desktopScreenshotOnSendEnabled: adapter.state.desktopScreenshotOnSendEnabled,
      connectionState: connectionState.value,
      connectionLabel: connectionLabel.value,
      connectionStatusMessage: adapter.state.statusMessage,
      aiState: aiState.value,
      micRequested: adapter.state.micRequested,
      micCapturing: adapter.state.micCapturing,
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
      baseActionPreview: baseActionPreview.value,
    });
  },
  { deep: true, immediate: true },
);

onMounted(async () => {
  await adapter.initialize();
  adapter.connect();
});

onBeforeUnmount(() => {
  motionPlayer.stopPlan("unmount");
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
      :stage-message="stageMessage"
    />
  </main>
</template>
