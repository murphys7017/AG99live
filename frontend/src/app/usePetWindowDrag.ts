import { onBeforeUnmount, ref } from "vue";

const WINDOW_DRAG_THRESHOLD_PX = 6;

function setPetWindowDragging(dragging: boolean): void {
  const targetWindow = window as Window & {
    __ag99PetWindowDragging?: boolean;
  };
  targetWindow.__ag99PetWindowDragging = dragging;
}

function setPetWindowPointerPending(pending: boolean): void {
  const targetWindow = window as Window & {
    __ag99PetWindowPointerPending?: boolean;
  };
  targetWindow.__ag99PetWindowPointerPending = pending;
}

function syncMouseIgnoreState(ignore: boolean): boolean {
  const syncMouseIgnore = (
    window as Window & {
      __ag99SetPetMouseIgnoreState?: (ignore: boolean) => void;
    }
  ).__ag99SetPetMouseIgnoreState;

  if (typeof syncMouseIgnore !== "function") {
    return false;
  }

  syncMouseIgnore(ignore);
  return true;
}

export function usePetWindowDrag(): {
  activePointerId: typeof activePointerId;
  isDragging: typeof isDragging;
  finishWindowDrag: () => void;
  handlePointerDown: (event: PointerEvent) => void;
  handlePointerMove: (event: PointerEvent) => void;
  handlePointerUp: (event: PointerEvent) => void;
  handlePointerCancel: (event: PointerEvent) => void;
} {
  const activePointerId = ref<number | null>(null);
  const isDragging = ref(false);
  let startScreenX = 0;
  let startScreenY = 0;
  function finishWindowDrag(): void {
    const hadPointer = activePointerId.value !== null;
    const wasDragging = isDragging.value;
    setPetWindowDragging(false);
    setPetWindowPointerPending(false);
    activePointerId.value = null;
    isDragging.value = false;
    if (wasDragging) {
      window.ag99desktop?.endWindowDrag();
    }
    if (!hadPointer && !wasDragging) {
      return;
    }
    if (syncMouseIgnoreState(true)) {
      return;
    }

    window.ag99desktop?.setIgnoreMouseEvents(true);
  }

  function handlePointerDown(event: PointerEvent): void {
    if (
      event.button !== 0
      || !event.isPrimary
      || event.altKey
      || activePointerId.value !== null
    ) {
      return;
    }

    setPetWindowPointerPending(true);
    activePointerId.value = event.pointerId;
    startScreenX = event.screenX;
    startScreenY = event.screenY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function handlePointerMove(event: PointerEvent): void {
    if (activePointerId.value !== event.pointerId) {
      return;
    }

    if (!isDragging.value) {
      const distance = Math.hypot(
        event.screenX - startScreenX,
        event.screenY - startScreenY,
      );
      if (distance < WINDOW_DRAG_THRESHOLD_PX) {
        return;
      }

      setPetWindowPointerPending(false);
      setPetWindowDragging(true);
      window.ag99desktop?.setIgnoreMouseEvents(false);
      isDragging.value = true;
      window.ag99desktop?.startWindowDrag(event.screenX, event.screenY);
    }

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

  return {
    activePointerId,
    isDragging,
    finishWindowDrag,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  };
}
