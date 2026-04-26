<script setup lang="ts">
import DesktopWindowPanel from "../components/DesktopWindowPanel.vue";
import SemanticAxisProfileEditor from "../components/SemanticAxisProfileEditor.vue";
</script>

<template>
  <DesktopWindowPanel title="Profile Editor" subtitle="Semantic Axis Profile">
    <section class="settings-grid">
      <SemanticAxisProfileEditor />
    </section>
  </DesktopWindowPanel>
</template>
