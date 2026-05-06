<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";

const bridge = useDesktopBridge();
const draft = ref("");
const overlayCardRef = ref<HTMLElement | null>(null);
const activePointerId = ref<number | null>(null);
const isDragging = ref(false);
const isPointerInteracting = ref(false);
let resizeObserver: ResizeObserver | null = null;
let heightSyncFrameId = 0;
let lastSyncedOverlayHeight = 0;

const aiStateLabel = computed(() => {
  switch (bridge.state.snapshot.aiState) {
    case "connecting":
      return "连接中";
    case "thinking":
      return "思考中";
    case "speaking":
      return "播放中";
    case "listening":
      return "待收音";
    case "error":
      return "异常";
    case "idle":
      return "待命";
    default:
      return "离线";
  }
});

const previewText = computed(() => {
  if (bridge.state.snapshot.lastAssistantText.trim()) {
    return bridge.state.snapshot.lastAssistantText.trim();
  }
  return bridge.state.snapshot.connectionStatusMessage;
});

const isMicCapturing = computed(() => bridge.state.snapshot.micCapturing);
const voiceActive = computed(() =>
  bridge.state.snapshot.micCapturing || bridge.state.snapshot.audioPlaying,
);
const micButtonTitle = computed(() =>
  isMicCapturing.value ? "关闭常驻收音" : "开启常驻收音",
);

function handleSend(): void {
  const text = draft.value.trim();
  if (!text) {
    return;
  }

  bridge.sendCommand({ type: "send_text", text });
  draft.value = "";
}

function handleInterrupt(): void {
  bridge.sendCommand({ type: "interrupt" });
}

function handleMicrophoneToggle(): void {
  bridge.sendCommand({ type: "toggle_mic_capture" });
}

function syncOverlayContentHeight(): void {
  if (isDragging.value || isPointerInteracting.value) {
    return;
  }

  const overlayCard = overlayCardRef.value;
  if (!overlayCard) {
    return;
  }

  const nextHeight = Math.ceil(overlayCard.offsetHeight);
  if (!Number.isFinite(nextHeight) || nextHeight <= 0 || nextHeight === lastSyncedOverlayHeight) {
    return;
  }

  lastSyncedOverlayHeight = nextHeight;
  window.ag99desktop?.setOverlayContentHeight(nextHeight);
}

function scheduleOverlayContentHeightSync(): void {
  if (heightSyncFrameId) {
    return;
  }

  heightSyncFrameId = window.requestAnimationFrame(() => {
    heightSyncFrameId = 0;
    syncOverlayContentHeight();
  });
}

function showContextMenu(event: MouseEvent): void {
  window.ag99desktop?.showContextMenu({
    x: event.clientX,
    y: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
  });
}

function onEnter(event: KeyboardEvent): void {
  if (event.isComposing) {
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    handleSend();
  }
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, button, textarea, select, a"));
}

function finishWindowDrag(): void {
  isPointerInteracting.value = false;
  if (activePointerId.value === null) {
    return;
  }

  activePointerId.value = null;
  isDragging.value = false;
  window.ag99desktop?.endWindowDrag();
  void nextTick(scheduleOverlayContentHeightSync);
}

function handlePointerDown(event: PointerEvent): void {
  isPointerInteracting.value = true;
  const target = event.target;
  const dragHandle =
    target instanceof HTMLElement
      ? target.closest("[data-overlay-drag]")
      : null;

  if (event.button !== 0 || isInteractiveTarget(target) || !dragHandle) {
    return;
  }

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
  isPointerInteracting.value = false;
  if (activePointerId.value !== event.pointerId) {
    void nextTick(scheduleOverlayContentHeightSync);
    return;
  }

  finishWindowDrag();
}

function handlePointerCancel(event: PointerEvent): void {
  isPointerInteracting.value = false;
  if (activePointerId.value !== event.pointerId) {
    void nextTick(scheduleOverlayContentHeightSync);
    return;
  }

  finishWindowDrag();
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    scheduleOverlayContentHeightSync();
  });
  if (overlayCardRef.value) {
    resizeObserver.observe(overlayCardRef.value);
  }
  void nextTick(scheduleOverlayContentHeightSync);
});

watch(previewText, () => {
  void nextTick(scheduleOverlayContentHeightSync);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (heightSyncFrameId) {
    window.cancelAnimationFrame(heightSyncFrameId);
    heightSyncFrameId = 0;
  }
  finishWindowDrag();
});
</script>

<template>
  <main
    class="desktop-shell desktop-shell--overlay"
    @contextmenu.prevent="showContextMenu"
  >
    <section
      ref="overlayCardRef"
      class="overlay-card"
      :class="{ 'overlay-card--dragging': isDragging }"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handlePointerUp"
      @pointercancel="handlePointerCancel"
      @lostpointercapture="finishWindowDrag"
    >
      <div class="overlay-card__drag-zone" data-overlay-drag>
        <div class="overlay-card__grip" aria-hidden="true"></div>

        <p
          class="overlay-card__message"
          :data-empty="!previewText.trim()"
        >
          {{ previewText.trim() || "..." }}
        </p>
      </div>

      <div class="overlay-card__status-row">
        <span class="overlay-card__status-label">{{ aiStateLabel }}</span>
        <div class="overlay-card__icon-group">
          <button
            type="button"
            class="overlay-card__icon-button overlay-card__icon-button--mic"
            :data-active="voiceActive"
            :title="micButtonTitle"
            @click="handleMicrophoneToggle"
          >
            <svg
              class="overlay-card__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 14a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v4a3 3 0 0 0 3 3Z" />
              <path d="M19 11a7 7 0 0 1-14 0" />
              <path d="M12 18v4" />
              <path d="M8 22h8" />
            </svg>
          </button>
          <button
            type="button"
            class="overlay-card__icon-button"
            title="打断"
            @click="handleInterrupt"
          >
            <svg
              class="overlay-card__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="7" y="7" width="10" height="10" rx="2" />
            </svg>
          </button>
        </div>
      </div>

      <form class="overlay-card__composer" @submit.prevent="handleSend">
        <input
          v-model="draft"
          class="overlay-card__input"
          type="text"
          placeholder="直接和桌宠说话"
          @keydown="onEnter"
        />
        <button
          type="submit"
          class="overlay-card__send"
          aria-label="发送"
        >
          <svg
            class="overlay-card__icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 3 9 15" />
            <path d="m21 3-8.5 18-3.5-6-6-3.5L21 3Z" />
          </svg>
        </button>
      </form>
    </section>
  </main>
</template>
