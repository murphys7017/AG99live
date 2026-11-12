export function useDesktopWindowActions(): {
  minimizeWindow: () => void;
  closeWindow: () => void;
} {
  function minimizeWindow(): void {
    desktopHostPort.getApi()?.minimizeCurrentWindow();
  }

  function closeWindow(): void {
    desktopHostPort.getApi()?.closeCurrentWindow();
  }

  return {
    minimizeWindow,
    closeWindow,
  };
}
import { desktopHostPort } from "./desktopHostPort.js";
