import type { Ag99DesktopApi } from "../types/desktop-runtime.js";

/**
 * Single boundary for the Electron preload surface.
 *
 * Feature modules should depend on this port instead of reaching into
 * window.ag99desktop directly. Keeping the lookup lazy also preserves the
 * browser/Web control fallback when preload is unavailable.
 */
export interface DesktopHostPort {
  getApi(): Ag99DesktopApi | null;
}

export const desktopHostPort: DesktopHostPort = {
  getApi(): Ag99DesktopApi | null {
    if (typeof window === "undefined") {
      return null;
    }
    return window.ag99desktop ?? null;
  },
};
