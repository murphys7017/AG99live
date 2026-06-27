import { onBeforeUnmount, ref } from "vue";

function setPetWindowDragging(dragging: boolean): void {
  const targetWindow = window as Window & {
    __ag99PetWindowDragging?: boolean;
  };
  targetWindow.__ag99PetWindowDragging = dragging;
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
  let rafHandle: number | null = null;
  let lastKnownScreenX = 0;
  let lastKnownScreenY = 0;

  function scheduleDragFlush(): void {
    if (rafHandle !== null) return;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = null;
      if (activePointerId.value === null) return;
      window.ag99desktop?.updateWindowDrag(lastKnownScreenX, lastKnownScreenY);
    });
  }

  function cancelDragFlush(): void {
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  }

  function finishWindowDrag(): void {
    if (activePointerId.value === null) {
      return;
    }

    cancelDragFlush();
    window.ag99desktop?.updateWindowDrag(lastKnownScreenX, lastKnownScreenY);
    setPetWindowDragging(false);
    activePointerId.value = null;
    isDragging.value = false;
    window.ag99desktop?.endWindowDrag();
    if (syncMouseIgnoreState(true)) {
      return;
    }

    window.ag99desktop?.setIgnoreMouseEvents(true);
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }

    cancelDragFlush();
    lastKnownScreenX = event.screenX;
    lastKnownScreenY = event.screenY;
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

    lastKnownScreenX = event.screenX;
    lastKnownScreenY = event.screenY;
    scheduleDragFlush();
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
