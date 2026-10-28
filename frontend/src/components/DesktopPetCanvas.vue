<script setup lang="ts">
import { toRef, watch } from "vue";
import type { ModelSummary } from "../types/protocol";
import type { PresenceRendererStatus } from "../presence/presenceStateStore";
import type { Live2dPresentationSettings } from "../live2d-renderer/settings";
import { useLive2dRenderer } from "../live2d-renderer/useLive2dRenderer";
import { usePetWindowDrag } from "../app/usePetWindowDrag";
import { useSpoutFramePublisher } from "../spout/useSpoutFramePublisher";
import { useSpoutSettings } from "../spout/useSpoutSettings";

const props = defineProps<{
  selectedModel: ModelSummary | null;
  live2dPresentationSettings: Live2dPresentationSettings;
  stageMessage: string;
}>();
const emit = defineEmits<{
  "renderer-status-change": [status: PresenceRendererStatus];
}>();

const selectedModelRef = toRef(props, "selectedModel");
const live2dPresentationSettingsRef = toRef(props, "live2dPresentationSettings");
const { containerRef, canvasRef, renderError, renderStatus } =
  useLive2dRenderer(selectedModelRef, live2dPresentationSettingsRef);
watch(renderStatus, (status) => emit("renderer-status-change", status), { immediate: true });
const { config: spoutConfig } = useSpoutSettings();
useSpoutFramePublisher(canvasRef, toRef(spoutConfig, "enabled"));
const {
  isDragging,
  finishWindowDrag,
  handlePointerDown,
  handlePointerUp,
  handlePointerCancel,
} = usePetWindowDrag();
</script>

<template>
  <section class="desktop-pet">
    <div class="desktop-pet__canvas-shell">
      <div
        id="live2d"
        ref="containerRef"
        class="desktop-pet__canvas-mount"
        :class="{ 'desktop-pet__canvas-mount--dragging': isDragging }"
        @pointerdown="handlePointerDown"
        @pointerup="handlePointerUp"
        @pointercancel="handlePointerCancel"
        @lostpointercapture="finishWindowDrag"
      >
        <canvas
          id="canvas"
          ref="canvasRef"
          class="desktop-pet__canvas"
        ></canvas>
      </div>
      <p v-if="renderError" class="desktop-pet__error">{{ renderError }}</p>
    </div>
  </section>
</template>
