<script setup lang="ts">
import { toRef } from "vue";
import type { ModelSummary } from "../types/protocol";
import { useLive2dRenderer } from "../live2d-renderer/useLive2dRenderer";
import { usePetWindowDrag } from "../app/usePetWindowDrag";

const props = defineProps<{
  selectedModel: ModelSummary | null;
  stageMessage: string;
}>();

const selectedModelRef = toRef(props, "selectedModel");
const { containerRef, canvasRef, renderError } =
  useLive2dRenderer(selectedModelRef);
const {
  isDragging,
  finishWindowDrag,
  handlePointerDown,
  handlePointerMove,
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
        @pointermove="handlePointerMove"
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
