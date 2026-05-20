<script setup lang="ts">
import { computed, onMounted } from "vue";
import DesktopWindowPanel from "../components/DesktopWindowPanel.vue";
import SemanticAxisProfileEditor from "../components/SemanticAxisProfileEditor.vue";
import { useDesktopBridge } from "../desktop-bridge/useDesktopBridge";
import type { DesktopProfileAuthoringCommand } from "../types/desktop";
import type { SemanticAxisProfile } from "../types/semantic-axis-profile";

const bridge = useDesktopBridge();
const subtitle = computed(() => {
  const modelName = bridge.state.modelProjectionSnapshot.selectedModelName.trim();
  return modelName ? `${modelName} Semantic Axis Profile` : "Semantic Axis Profile";
});
const currentProfile = computed<SemanticAxisProfile | null>(() => {
  const profile = bridge.state.modelProjectionSnapshot.runtimeSemanticAxisProfile;
  return profile ? JSON.parse(JSON.stringify(profile)) as SemanticAxisProfile : null;
});
const selectedModelName = computed(() =>
  bridge.state.modelProjectionSnapshot.selectedModelName.trim(),
);
const latestSaveResult = computed(() =>
  bridge.state.profileAuthoringSnapshot.latestSemanticAxisProfileSaveResult,
);

function saveSemanticAxisProfile(
  payload: Omit<DesktopProfileAuthoringCommand, "type">,
): void {
  bridge.sendProfileAuthoringCommand({
    type: "save_semantic_axis_profile",
    ...payload,
  });
}

onMounted(() => {
  bridge.sendCommand({ type: "request_model_projection_sync" });
});
</script>

<template>
  <DesktopWindowPanel title="Profile Editor" :subtitle="subtitle">
    <section class="settings-grid">
      <SemanticAxisProfileEditor
        :current-profile="currentProfile"
        :selected-model-name="selectedModelName"
        :latest-save-result="latestSaveResult"
        @save-semantic-axis-profile="saveSemanticAxisProfile"
      />
    </section>
  </DesktopWindowPanel>
</template>
