<script setup lang="ts">
import { computed } from "vue";
import BaseActionPreviewPanel from "../components/BaseActionPreviewPanel.vue";
import DesktopWindowPanel from "../components/DesktopWindowPanel.vue";
import MotionTuningPanel from "../components/MotionTuningPanel.vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import type { DesktopBaseActionPreview } from "../types/desktop";
import type { SemanticAxisProfile } from "../types/semantic-axis-profile";

const bridge = useDesktopBridge();
const baseActionPreview = computed<DesktopBaseActionPreview | null>(() => {
  const preview = bridge.state.snapshot.baseActionPreview;
  if (!preview) {
    return null;
  }
  return {
    ...preview,
    focusChannels: [...preview.focusChannels],
    focusDomains: [...preview.focusDomains],
    ignoredDomains: [...preview.ignoredDomains],
    summary: { ...preview.summary },
    analysis: { ...preview.analysis },
    families: preview.families.map((family) => ({
      ...family,
      channels: [...family.channels],
    })),
    channels: preview.channels.map((channel) => ({
      ...channel,
      polarityModes: [...channel.polarityModes],
      atomIds: [...channel.atomIds],
    })),
    atoms: preview.atoms.map((atom) => ({
      ...atom,
      sourceTags: [...atom.sourceTags],
    })),
  };
});
const semanticProfile = computed<SemanticAxisProfile | null>(() => {
  const profile = bridge.state.snapshot.runtimeSemanticAxisProfile;
  return profile ? JSON.parse(JSON.stringify(profile)) as SemanticAxisProfile : null;
});
</script>

<template>
  <DesktopWindowPanel title="动作实验室" subtitle="Motion Plan Sandbox">
    <section class="settings-grid">
      <MotionTuningPanel />
      <BaseActionPreviewPanel
        :preview="baseActionPreview"
        :semantic-profile="semanticProfile"
        :allow-play="true"
      />
    </section>
  </DesktopWindowPanel>
</template>
