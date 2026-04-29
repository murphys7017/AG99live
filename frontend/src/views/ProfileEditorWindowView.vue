<script setup lang="ts">
import { computed } from "vue";
import DesktopWindowPanel from "../components/DesktopWindowPanel.vue";
import SemanticAxisProfileEditor from "../components/SemanticAxisProfileEditor.vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";

const bridge = useDesktopBridge();
const subtitle = computed(() => {
  const modelName = bridge.state.snapshot.selectedModelName.trim();
  return modelName ? `${modelName} Semantic Axis Profile` : "Semantic Axis Profile";
});
</script>

<template>
  <DesktopWindowPanel title="Profile Editor" :subtitle="subtitle">
    <section class="settings-grid">
      <SemanticAxisProfileEditor />
    </section>
  </DesktopWindowPanel>
</template>
