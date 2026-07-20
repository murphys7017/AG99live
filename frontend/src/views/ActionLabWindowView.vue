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
import type { CompiledSemanticMotion } from "../model-engine/compiler/contracts";
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

const motionPreviewStatusText = computed(() => {
  const status = bridge.state.motionPreviewStatus;
  if (!status) {
    return "";
  }
  const labels = {
    requested: "已请求",
    started: "播放中",
    rejected: "已拒绝",
    completed: "播放完成",
    failed: "播放失败",
    stopped: "已停止",
  } as const;
  return `${labels[status.status]}${status.reason ? `：${status.reason}` : ""}`;
});

function createPreviewRequestId(): string {
  return `motion-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function previewCompiledSemanticMotion(semanticMotion: CompiledSemanticMotion): void {
  bridge.sendCommand({
    type: "preview_compiled_semantic_motion",
    requestId: createPreviewRequestId(),
    semanticMotion,
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
    <p v-if="motionPreviewStatusText" class="history-empty">
      {{ motionPreviewStatusText }}
    </p>
    <section class="settings-grid">
      <MotionTuningPanel
        :semantic-profile="semanticProfile"
        :motion-playback-records="motionPlaybackRecords"
        :motion-tuning-samples="motionTuningSamples"
        :motion-tuning-samples-status="motionTuningSamplesStatus"
        :effective-examples="effectiveExamples"
        @request-motion-tuning-samples-sync="sendRuntimeCommand('request_motion_tuning_samples_sync')"
        @preview-compiled-semantic-motion="previewCompiledSemanticMotion"
        @save-motion-tuning-sample="saveMotionTuningSample"
        @delete-motion-tuning-sample="deleteMotionTuningSample"
      />
      <BaseActionPreviewPanel
        :preview="parameterActionPreview"
        :semantic-profile="semanticProfile"
      />
    </section>
  </DesktopWindowPanel>
</template>
