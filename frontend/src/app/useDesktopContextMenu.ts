import { desktopHostPort } from "../desktop-bridge/desktopHostPort.js";

export function useDesktopContextMenu(): {
  showContextMenu: (event: MouseEvent) => void;
} {
  function showContextMenu(event: MouseEvent): void {
    desktopHostPort.getApi()?.showContextMenu({
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
