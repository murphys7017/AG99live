<script setup lang="ts">
import { onBeforeUnmount, ref, toRef } from "vue";
import type { ModelSummary } from "../types/protocol";
import { useLive2dRenderer } from "../composables/useLive2dRenderer";

const props = defineProps<{
  selectedModel: ModelSummary | null;
  stageMessage: string;
}>();

const selectedModelRef = toRef(props, "selectedModel");
const { containerRef, canvasRef, renderError } =
  useLive2dRenderer(selectedModelRef);

const activePointerId = ref<number | null>(null);
const isDragging = ref(false);

function setPetWindowDragging(dragging: boolean): void {
  const targetWindow = window as Window & {
    __ag99PetDragging?: boolean;
    __ag99PetWindowDragging?: boolean;
  };
  targetWindow.__ag99PetDragging = dragging;
  targetWindow.__ag99PetWindowDragging = dragging;
}

function finishWindowDrag(): void {
  if (activePointerId.value === null) {
    return;
  }

  const syncMouseIgnoreState = (
    window as Window & {
      __ag99SetPetMouseIgnoreState?: (ignore: boolean) => void;
    }
  ).__ag99SetPetMouseIgnoreState;

  setPetWindowDragging(false);
  activePointerId.value = null;
  isDragging.value = false;
  window.ag99desktop?.endWindowDrag();
  if (typeof syncMouseIgnoreState === "function") {
    syncMouseIgnoreState(true);
    return;
  }

  window.ag99desktop?.setIgnoreMouseEvents(true);
}

function handlePointerDown(event: PointerEvent): void {
  if (event.button !== 0) {
    return;
  }

  setPetWindowDragging(true);
  window.ag99desktop?.setIgnoreMouseEvents(false);
  activePointerId.value = event.pointerId;
  isDragging.value = true;
  window.ag99desktop?.startWindowDrag(event.screenX, event.screenY);
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function handlePointerMove(event: PointerEvent): void {
  if (activePointerId.value !== event.pointerId) {
    return;
  }

  window.ag99desktop?.updateWindowDrag(event.screenX, event.screenY);
}

function handlePointerUp(event: PointerEvent): void {
  if (activePointerId.value !== event.pointerId) {
    return;
  }

  finishWindowDrag();
}

function handlePointerCancel(event: PointerEvent): void {
  if (activePointerId.value !== event.pointerId) {
    return;
  }

  finishWindowDrag();
}

onBeforeUnmount(() => {
  finishWindowDrag();
});
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
