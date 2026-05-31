<script setup lang="ts">
import { computed, onMounted } from "vue";
import BaseActionPreviewPanel from "../components/BaseActionPreviewPanel.vue";
import DesktopWindowPanel from "../components/DesktopWindowPanel.vue";
import MotionTuningPanel from "../components/MotionTuningPanel.vue";
import { useDesktopBridge } from "../desktop-bridge/useDesktopBridge";
import type {
  DesktopBaseActionPreview,
  DesktopMotionPlaybackRecord,
  DesktopMotionTuningSample,
} from "../types/desktop";
import type { SemanticAxisProfile } from "../types/semantic-axis-profile";

const bridge = useDesktopBridge();
const parameterActionPreview = computed<DesktopBaseActionPreview | null>(() => {
  const preview = bridge.state.modelProjectionSnapshot.baseActionPreview;
  return preview as unknown as DesktopBaseActionPreview | null;
});
const semanticProfile = computed<SemanticAxisProfile | null>(() => {
  const profile = bridge.state.modelProjectionSnapshot.runtimeSemanticAxisProfile;
  return profile as unknown as SemanticAxisProfile | null;
});
const motionPlaybackRecords = computed(() =>
  bridge.state.snapshot.motionPlaybackRecords as unknown as readonly DesktopMotionPlaybackRecord[],
);
const motionTuningSamples = computed(() =>
  bridge.state.motionTuningSamples as unknown as readonly DesktopMotionTuningSample[],
);
const motionTuningSamplesStatus = computed(() => bridge.state.motionTuningSamplesStatus);
const effectiveExamples = computed(() =>
  bridge.state.modelProjectionSnapshot.motionTuningEffectiveExamples,
);

function sendRuntimeCommand(type: "request_model_projection_sync" | "request_motion_tuning_samples_sync"): void {
  bridge.sendCommand({ type });
}

function previewMotionPayload(payload: unknown): void {
  bridge.sendCommand({
    type: "preview_motion_payload",
    payload,
  });
}

function saveMotionTuningSample(sample: DesktopMotionTuningSample): void {
  bridge.sendCommand({
    type: "save_motion_tuning_sample",
    sample,
  });
}

function deleteMotionTuningSample(sampleId: string): void {
  bridge.sendCommand({
    type: "delete_motion_tuning_sample",
    sampleId,
  });
}

onMounted(() => {
  sendRuntimeCommand("request_model_projection_sync");
});
</script>

<template>
  <DesktopWindowPanel title="动作实验室" subtitle="Motion Plan Sandbox">
    <section class="settings-grid">
      <MotionTuningPanel
        :semantic-profile="semanticProfile"
        :motion-playback-records="motionPlaybackRecords"
        :motion-tuning-samples="motionTuningSamples"
        :motion-tuning-samples-status="motionTuningSamplesStatus"
        :effective-examples="effectiveExamples"
        @request-motion-tuning-samples-sync="sendRuntimeCommand('request_motion_tuning_samples_sync')"
        @preview-motion-payload="previewMotionPayload"
        @save-motion-tuning-sample="saveMotionTuningSample"
        @delete-motion-tuning-sample="deleteMotionTuningSample"
      />
      <BaseActionPreviewPanel
        :preview="parameterActionPreview"
        :semantic-profile="semanticProfile"
        :allow-play="true"
        @preview-motion-payload="previewMotionPayload"
      />
    </section>
  </DesktopWindowPanel>
</template>
