export function useDesktopContextMenu(): {
  showContextMenu: (event: MouseEvent) => void;
} {
  function showContextMenu(event: MouseEvent): void {
    window.ag99desktop?.showContextMenu({
      x: event.clientX,
      y: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
    });
  }

  return {
    showContextMenu,
  };
}
