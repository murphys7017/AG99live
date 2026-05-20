export function useDesktopWindowActions(): {
  minimizeWindow: () => void;
  closeWindow: () => void;
} {
  function minimizeWindow(): void {
    window.ag99desktop?.minimizeCurrentWindow();
  }

  function closeWindow(): void {
    window.ag99desktop?.closeCurrentWindow();
  }

  return {
    minimizeWindow,
    closeWindow,
  };
}
