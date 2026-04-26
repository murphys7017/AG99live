<script setup lang="ts">
import { computed } from "vue";
import BaseActionPreviewPanel from "../components/BaseActionPreviewPanel.vue";
import DesktopWindowPanel from "../components/DesktopWindowPanel.vue";
import MotionTuningPanel from "../components/MotionTuningPanel.vue";
import SemanticAxisProfileEditor from "../components/SemanticAxisProfileEditor.vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import type { DesktopBaseActionPreview } from "../types/desktop";

const bridge = useDesktopBridge();
const showLegacyMotionTuningPanel = computed(() =>
  bridge.state.snapshot.motionPlaybackRecords.some(
    (record) => record.plan.schema_version === "engine.parameter_plan.v1",
  )
  || bridge.state.snapshot.motionTuningSamples.some(
    (sample) => sample.adjustedPlan.schema_version === "engine.parameter_plan.v1",
  ),
);
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
</script>

<template>
  <DesktopWindowPanel title="动作实验室" subtitle="Motion Plan Sandbox">
    <section class="settings-grid">
      <SemanticAxisProfileEditor />
      <BaseActionPreviewPanel
        :preview="baseActionPreview"
        :allow-play="true"
      />
      <MotionTuningPanel v-if="showLegacyMotionTuningPanel" />
    </section>
  </DesktopWindowPanel>
</template>
