<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import DesktopPetCanvas from "../components/DesktopPetCanvas.vue";
import { useAdapterConnection } from "../composables/useAdapterConnection";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import { useModelSync } from "../composables/useModelSync";
import {
  cloneModelEngineSettings,
  modelEngineSettingsEqual,
  normalizeModelEngineSettings,
} from "../model-engine/settings";
import { usePreviewMotionPlayer } from "../composables/usePreviewMotionPlayer";
import { useModelEngine } from "../model-engine/useModelEngine";
import type {
  DesktopMotionPlaybackRecord,
  DesktopProfileAuthoringCommand,
  DesktopMotionTuningSample,
  DesktopRuntimeCommand,
} from "../types/desktop";
import type { ModelEnginePlanStartedEvent } from "../model-engine/contracts";
import type { DesktopBaseActionPreview } from "../types/desktop";

const { state, selectedModel, selectedSemanticAxisProfile } = useModelSync();
const adapter = useAdapterConnection();
const bridge = useDesktopBridge();
const motionPlayer = usePreviewMotionPlayer();
const MAX_MOTION_PLAYBACK_RECORDS = 5;
const motionEngineSettings = reactive(
  cloneModelEngineSettings(bridge.state.snapshot.motionEngineSettings),
);
const motionPlaybackRecords = ref<DesktopMotionPlaybackRecord[]>(
  bridge.state.snapshot.motionPlaybackRecords.map((record) =>
    cloneJson(record) as DesktopMotionPlaybackRecord),
);
const modelEngine = useModelEngine({
  getSelectedModel: () => selectedModel.value,
  getSettings: () => cloneModelEngineSettings(motionEngineSettings),
  playPlan: (plan, model, options) => motionPlayer.playPlan(plan, model, options),
  stopPlan: (reason) => motionPlayer.stopPlan(reason),
  getCurrentTurnId: () => adapter.state.currentTurnId,
  getAudioPlaybackInfo: () => ({
    turnId: adapter.state.audioPlaybackStartedTurnId,
    startedAtMs: adapter.state.audioPlaybackStartedAtMs,
    durationMs: adapter.state.audioPlaybackDurationMs,
  }),
  pushHistory: (role, text) => adapter.pushHistory(role, text),
  getPlayerMessage: () => motionPlayer.state.message,
  onPlanStarted: (event) => recordMotionPlayback(event),
});
const ambientMotionEnabled = ref(bridge.state.snapshot.ambientMotionEnabled);

function applyMotionEngineSettingsSnapshot(nextValue: unknown): void {
  const normalized = normalizeModelEngineSettings(nextValue);
  const currentSettings = cloneModelEngineSettings(motionEngineSettings);
  if (modelEngineSettingsEqual(currentSettings, normalized)) {
    return;
  }
  motionEngineSettings.motionIntensityScale = normalized.motionIntensityScale;
  motionEngineSettings.axisIntensityScale = {
    ...normalized.axisIntensityScale,
  };
}

applyMotionEngineSettingsSnapshot(bridge.state.snapshot.motionEngineSettings);

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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((item) => item.trim()))];
}

function formatLabelFromKey(key: string, fallback: string): string {
  const normalized = key.trim();
  if (!normalized) {
    return fallback;
  }
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolvePrimaryChannel(
  primaryChannel: string,
  channels: string[],
): string {
  const normalizedPrimary = primaryChannel.trim();
  if (normalizedPrimary) {
    return normalizedPrimary;
  }
  const first = channels.find((item) => item.trim());
  return first?.trim() || "parameter";
}

const parameterActionPreview = computed<DesktopBaseActionPreview | null>(() => {
  const model = selectedModel.value;
  const library = model?.parameter_action_library;
  if (!library) {
    return null;
  }
  const runtimeCacheErrors = state.modelInfo?.runtime_cache_errors;
  const runtimeCacheDiagnostics = [
    runtimeCacheErrors?.scan_cache
      ? `runtime cache scan_cache 异常：${runtimeCacheErrors.scan_cache}`
      : "",
    runtimeCacheErrors?.action_filter_cache
      ? `runtime cache action_filter_cache 异常：${runtimeCacheErrors.action_filter_cache}`
      : "",
  ].filter(Boolean).join(" | ");

  const channelCandidateCountByName = new Map<string, number>();
  for (const item of library.channels) {
    channelCandidateCountByName.set(
      item.name,
      Number.isFinite(item.count) ? item.count : 0,
    );
  }

  const channelAtomIdsByName = new Map<string, string[]>();
  const channelDomainByName = new Map<string, string>();
  const channelPolarityByName = new Map<string, Set<string>>();
  const mappedAtoms = library.atoms
    .map((atom) => {
      const atomChannels = uniqueStrings([...(atom.channels ?? [])]);
      const channel = resolvePrimaryChannel(atom.primary_channel ?? "", atomChannels);
      const polarity = atom.polarity || "neutral";
      const channelLabel = formatLabelFromKey(channel, "parameter");
      const family = atom.kind || "parameter";
      const familyLabel = formatLabelFromKey(family, "parameter");

      const nextAtomIds = channelAtomIdsByName.get(channel) ?? [];
      nextAtomIds.push(atom.id);
      channelAtomIdsByName.set(channel, nextAtomIds);
      if (!channelDomainByName.get(channel)) {
        channelDomainByName.set(channel, atom.domain || "other");
      }
      const polarityModes = channelPolarityByName.get(channel) ?? new Set<string>();
      polarityModes.add(polarity);
      channelPolarityByName.set(channel, polarityModes);

      return {
        id: atom.id,
        name: atom.name,
        label: atom.label,
        channel,
        channelLabel,
        family,
        familyLabel,
        domain: atom.domain || "other",
        polarity,
        semanticPolarity: atom.semantic_polarity || polarity,
        trait: atom.trait,
        strength: atom.strength,
        score: atom.score,
        energyScore: atom.energy_score,
        primaryParameterMatch: true,
        channelPurity: atomChannels.length ? 1 / atomChannels.length : 1,
        sourceMotion: atom.source_motion,
        sourceFile: atom.source_file,
        sourceGroup: atom.source_group,
        sourceCategory: atom.source_category,
        sourceTags: [...atom.source_tags],
        duration: atom.duration,
        fps: atom.fps,
        loop: atom.loop,
        intensity: atom.intensity,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.energyScore !== left.energyScore) {
        return right.energyScore - left.energyScore;
      }
      return left.id.localeCompare(right.id);
    });

  const orderedChannelNames = uniqueStrings([
    ...library.channels.map((item) => item.name),
    ...[...channelAtomIdsByName.keys()],
  ]);
  const channels = orderedChannelNames.map((channelName) => {
    const atomIds = channelAtomIdsByName.get(channelName) ?? [];
    return {
      name: channelName,
      label: formatLabelFromKey(channelName, "parameter"),
      family: "parameter",
      familyLabel: "parameter",
      domain: channelDomainByName.get(channelName) ?? "other",
      available: true,
      candidateComponentCount: channelCandidateCountByName.get(channelName) ?? atomIds.length,
      selectedAtomCount: atomIds.length,
      polarityModes: [...(channelPolarityByName.get(channelName) ?? new Set<string>())],
      atomIds: [...atomIds],
    };
  });

  const familyAccumulator = new Map<
    string,
    { channels: Set<string>; atomCount: number }
  >();
  for (const parameter of library.parameters) {
    const kind = (parameter.kind || "parameter").trim() || "parameter";
    const current = familyAccumulator.get(kind) ?? {
      channels: new Set<string>(),
      atomCount: 0,
    };
    for (const channel of parameter.channels ?? []) {
      if (channel.trim()) {
        current.channels.add(channel.trim());
      }
    }
    current.atomCount += Number(parameter.selected_atom_count || 0);
    familyAccumulator.set(kind, current);
  }
  const families = [...familyAccumulator.entries()].map(([name, value]) => ({
    name,
    label: formatLabelFromKey(name, "parameter"),
    channels: [...value.channels],
    atomCount: value.atomCount,
  }));

  const selectedChannelCount = channels.filter(
    (channel) => channel.selectedAtomCount > 0,
  ).length;

  return {
    schemaVersion: library.schema_version,
    extractionMode: library.extraction_mode,
    focusChannels: library.channels.map((item) => item.name),
    focusDomains: library.domains.map((item) => item.name),
    ignoredDomains: [],
    summary: {
      motionCount: library.summary.motion_count,
      availableChannelCount: channels.length,
      selectedChannelCount,
      candidateComponentCount: library.summary.driver_component_count,
      selectedAtomCount: library.summary.selected_atom_count,
      familyCount: library.summary.selected_parameter_count,
    },
    analysis: {
      status: library.analysis.status,
      mode: library.analysis.mode,
      providerId: library.analysis.provider_id,
      inputSignature: "",
      latencyMs: 0,
      cacheHit: false,
      selectedChannelCount,
      error: [library.analysis.error ?? "", runtimeCacheDiagnostics].filter(Boolean).join(" | "),
      fallbackReason: "",
    },
    families,
    channels,
    atoms: mappedAtoms,
  };
});

function handlePreviewMotionPlan(plan: unknown): void {
  const localPlayed = modelEngine.playPreviewPayload(plan);
  if (!localPlayed) {
    console.warn("[AG99live] Local motion preview playback failed to start.");
  }
  adapter.sendMotionPayloadPreview(plan);
}

function recordMotionPlayback(event: ModelEnginePlanStartedEvent): void {
  const now = new Date();
  const record: DesktopMotionPlaybackRecord = {
    id: `motion-record-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now.toISOString(),
    source: event.diagnostics?.source || event.startReason,
    payloadKind: event.payloadKind,
    turnId: event.turnId,
    modelName: event.model?.name ?? selectedModel.value?.name ?? "",
    emotionLabel: event.plan.emotion_label,
    mode: event.plan.mode,
    startReason: event.startReason,
    queuedDelayMs: event.queuedDelayMs,
    assistantText: adapter.state.lastAssistantText,
    playerMessage: event.playerMessage,
    diagnostics: event.diagnostics
      ? {
        ...event.diagnostics,
        axisIntensityScale: { ...event.diagnostics.axisIntensityScale },
      }
      : null,
    plan: cloneJson(event.plan),
  };
  motionPlaybackRecords.value = [
    record,
    ...motionPlaybackRecords.value,
  ].slice(0, MAX_MOTION_PLAYBACK_RECORDS);
}

function saveMotionTuningSample(sample: DesktopMotionTuningSample): void {
  adapter.saveMotionTuningSample(cloneJson(sample));
}

function deleteMotionTuningSample(sampleId: string): void {
  adapter.deleteMotionTuningSample(sampleId);
}

function cloneJson<TValue>(value: TValue): TValue {
  return JSON.parse(JSON.stringify(value)) as TValue;
}

function serializeAxisIntensityScale(axisIntensityScale: Record<string, number>): string {
  return JSON.stringify(
    Object.entries(axisIntensityScale).sort(([left], [right]) =>
      left.localeCompare(right)),
  );
}

function applyAmbientMotionPreference(attemptsRemaining = 12): void {
  const live2dAdapter = window.getLAppAdapter?.();
  if (live2dAdapter?.setAmbientMotionEnabled) {
    live2dAdapter.setAmbientMotionEnabled(ambientMotionEnabled.value);
    return;
  }

  if (attemptsRemaining <= 0) {
    return;
  }

  window.setTimeout(() => {
    applyAmbientMotionPreference(attemptsRemaining - 1);
  }, 120);
}

function handleDesktopCommand(command: DesktopRuntimeCommand): void {
  switch (command.type) {
    case "set_address":
      adapter.setAddress(command.address);
      return;
    case "set_desktop_screenshot_on_send":
      adapter.setDesktopScreenshotOnSendEnabled(command.enabled);
      return;
    case "set_ambient_motion_enabled":
      ambientMotionEnabled.value = command.enabled;
      applyAmbientMotionPreference();
      return;
    case "set_motion_engine_settings":
      applyMotionEngineSettingsSnapshot(command.settings);
      return;
    case "request_motion_tuning_samples_sync":
      bridge.publishMotionTuningSamples(
        adapter.state.motionTuningSamples,
        adapter.state.motionTuningSamplesStatus,
      );
      return;
    case "save_motion_tuning_sample":
      saveMotionTuningSample(command.sample);
      return;
    case "delete_motion_tuning_sample":
      deleteMotionTuningSample(command.sampleId);
      return;
    case "request_history_list":
      adapter.requestHistoryList();
      return;
    case "create_history":
      adapter.createHistory();
      return;
    case "load_history":
      adapter.loadHistory(command.historyUid);
      return;
    case "delete_history":
      adapter.deleteHistory(command.historyUid);
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
      modelEngine.stop("interrupted");
      adapter.interruptCurrentTurn();
      return;
    case "toggle_mic_capture":
      void adapter.toggleMicrophoneCapture();
      return;
    case "preview_motion_plan":
      handlePreviewMotionPlan(command.plan);
      return;
    case "preview_motion_payload":
      handlePreviewMotionPlan(command.payload);
      return;
  }
}

function handleProfileAuthoringCommand(
  command: DesktopProfileAuthoringCommand,
): void {
  if (command.type !== "save_semantic_axis_profile") {
    return;
  }

  adapter.sendSemanticAxisProfileSave({
    request_id: command.requestId,
    model_name: command.modelName,
    profile_id: command.profileId,
    expected_revision: command.expectedRevision,
    profile: cloneJson(command.profile),
  });
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
const detachProfileAuthoringBridgeListener = bridge.onProfileAuthoringCommand(
  handleProfileAuthoringCommand,
);

watch(
  () => adapter.state.inboundMotionPlanNonce,
  () => {
    console.info("[PetDesktopView] inboundMotionPlanNonce watch fired. nonce=", adapter.state.inboundMotionPlanNonce);
    const plan = adapter.state.inboundMotionPlan;
    if (!plan) {
      console.warn("[PetDesktopView] inboundMotionPlan is null, skipping.");
      return;
    }
    modelEngine.ingestInboundPayload(plan, {
      turnId: adapter.state.inboundMotionPlanTurnId,
      receivedAtMs: adapter.state.inboundMotionPlanReceivedAtMs,
    });
  },
);

watch(
  () => adapter.state.audioPlaybackStartedNonce,
  () => {
    modelEngine.notifyAudioPlaybackStarted(adapter.state.audioPlaybackStartedTurnId);
  },
);

watch(
  () => adapter.state.currentTurnId,
  (turnId) => {
    modelEngine.notifyCurrentTurnChanged(turnId);
  },
);

watch(
  () => ({
    samples: adapter.state.motionTuningSamples,
    status: adapter.state.motionTuningSamplesStatus,
  }),
  ({ samples, status }) => {
    bridge.publishMotionTuningSamples(samples, status);
  },
  { deep: true, immediate: true },
);

watch(
  () => [
    ambientMotionEnabled.value,
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
    adapter.state.backendHistorySummaries,
    adapter.state.backendHistoryEntries,
    adapter.state.activeBackendHistoryUid,
    adapter.state.backendHistoryLoading,
    adapter.state.backendHistoryStatusMessage,
    state.confName,
    state.lastUpdated,
    selectedModel.value?.name ?? "",
    selectedModel.value?.icon_url ?? "",
    selectedModel.value?.engine_hints.recommended_mode ?? "",
    parameterActionPreview.value,
    stageMessage.value,
    motionEngineSettings.motionIntensityScale,
    serializeAxisIntensityScale(motionEngineSettings.axisIntensityScale),
    motionPlaybackRecords.value,
    selectedSemanticAxisProfile.value,
  ],
  () => {
    bridge.publishSnapshot({
      adapterAddress: adapter.state.address,
      desktopScreenshotOnSendEnabled: adapter.state.desktopScreenshotOnSendEnabled,
      ambientMotionEnabled: ambientMotionEnabled.value,
      motionEngineSettings: cloneModelEngineSettings(motionEngineSettings),
      motionPlaybackRecords: motionPlaybackRecords.value.map((record) =>
        cloneJson(record)),
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
      backendHistorySummaries: adapter.state.backendHistorySummaries.map((summary) =>
        cloneJson(summary)),
      backendHistoryEntries: adapter.state.backendHistoryEntries.map((entry) =>
        cloneJson(entry)),
      activeBackendHistoryUid: adapter.state.activeBackendHistoryUid,
      backendHistoryLoading: adapter.state.backendHistoryLoading,
      backendHistoryStatusMessage: adapter.state.backendHistoryStatusMessage,
      runtimeSemanticAxisProfile: selectedSemanticAxisProfile.value
        ? cloneJson(selectedSemanticAxisProfile.value)
        : null,
      baseActionPreview: parameterActionPreview.value,
    });
  },
  { deep: true, immediate: true },
);

watch(
  () => adapter.state.latestSemanticAxisProfileSaveResult,
  () => {
    bridge.publishProfileAuthoringSnapshot({
      latestSemanticAxisProfileSaveResult: adapter.state.latestSemanticAxisProfileSaveResult
        ? cloneJson(adapter.state.latestSemanticAxisProfileSaveResult)
        : null,
    });
  },
  { deep: true, immediate: true },
);

watch(
  () => [selectedModel.value?.model_url ?? "", ambientMotionEnabled.value],
  () => {
    applyAmbientMotionPreference();
  },
  { immediate: true },
);

onMounted(async () => {
  await adapter.initialize();
  adapter.connect();
  applyAmbientMotionPreference();
});

onBeforeUnmount(() => {
  modelEngine.stop("unmount");
  detachBridgeListener();
  detachProfileAuthoringBridgeListener();
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
