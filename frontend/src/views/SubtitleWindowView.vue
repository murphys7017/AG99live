<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useDesktopBridge } from "../desktop-bridge/useDesktopBridge";

const bridge = useDesktopBridge();
const activePointerId = ref<number | null>(null);
const isDragging = ref(false);

const subtitleText = computed(() => bridge.state.snapshot.lastAssistantText.trim());

watch(
  subtitleText,
  (text) => {
    window.ag99desktop?.setIgnoreMouseEvents(!text);
  },
  { immediate: true },
);

function showContextMenu(event: MouseEvent): void {
  window.ag99desktop?.showContextMenu({
    x: event.clientX,
    y: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
  });
}

function finishWindowDrag(): void {
  if (activePointerId.value === null) {
    return;
  }

  activePointerId.value = null;
  isDragging.value = false;
  window.ag99desktop?.endWindowDrag();
}

function handlePointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !event.isPrimary || activePointerId.value !== null) {
    return;
  }

  activePointerId.value = event.pointerId;
  isDragging.value = true;
  window.ag99desktop?.startWindowDrag(event.screenX, event.screenY);
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
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
  <main
    class="desktop-shell desktop-shell--subtitle"
    @contextmenu.prevent="showContextMenu"
  >
    <section
      class="subtitle-window"
      :class="{
        'subtitle-window--empty': !subtitleText,
        'subtitle-window--dragging': isDragging,
      }"
      @pointerdown="handlePointerDown"
      @pointerup="handlePointerUp"
      @pointercancel="handlePointerCancel"
      @lostpointercapture="finishWindowDrag"
    >
      <div class="subtitle-window__drag-zone">
        <span v-if="subtitleText" class="subtitle-window__label">AG99live</span>
        <p
          v-if="subtitleText"
          class="subtitle-window__text"
          aria-live="polite"
        >
          {{ subtitleText }}
        </p>
      </div>
    </section>
  </main>
</template>
