<script setup lang="ts">
import { computed, toRef } from "vue";
import type { ModelSummary } from "../types/protocol";
import { useLive2dRenderer } from "../composables/useLive2dRenderer";

const props = defineProps<{
  selectedModel: ModelSummary | null;
  statusText: string;
  stageMessage: string;
}>();

const selectedModelRef = toRef(props, "selectedModel");
const { containerRef, canvasRef, renderStatus, renderError } =
  useLive2dRenderer(selectedModelRef);

const fallbackTitle = computed(() => props.selectedModel?.name || "AG99live");
const statusTone = computed(() => {
  if (renderError.value) {
    return "error";
  }
  if (renderStatus.value === "ready") {
    return "ready";
  }
  return "loading";
});
</script>

<template>
  <section class="desktop-pet">
    <header class="desktop-pet__topline">
      <div class="desktop-pet__name-chip">{{ fallbackTitle }}</div>
      <div class="desktop-pet__status-chip" :data-tone="statusTone">
        {{ statusText }}
      </div>
    </header>

    <div class="desktop-pet__canvas-shell">
      <div
        id="live2d"
        ref="containerRef"
        class="desktop-pet__canvas-mount"
      >
        <canvas
          id="canvas"
          ref="canvasRef"
          class="desktop-pet__canvas"
        ></canvas>
      </div>

      <div class="desktop-pet__glow" aria-hidden="true"></div>
      <div class="desktop-pet__floor" aria-hidden="true"></div>

      <div v-if="renderStatus !== 'ready'" class="desktop-pet__fallback">
        <strong>{{ fallbackTitle }}</strong>
        <p>{{ stageMessage }}</p>
      </div>

      <p v-if="renderError" class="desktop-pet__error">{{ renderError }}</p>
    </div>
  </section>
</template>
