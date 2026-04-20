import type {
  DesktopAuxWindowRole,
  DesktopWindowVisibilityState,
} from "./desktop";

export interface Ag99DesktopApi {
  showContextMenu: () => void;
  setIgnoreMouseEvents: (ignore: boolean) => void;
  startWindowDrag: (screenX: number, screenY: number) => void;
  updateWindowDrag: (screenX: number, screenY: number) => void;
  endWindowDrag: () => void;
  getLocalAdapterHosts: () => string[];
  captureDesktopScreenshot: () => Promise<{
    data: string;
    mime_type: "image/jpeg";
    source: "screen";
    captured_at: string;
  } | null>;
  toggleAuxWindow: (target: DesktopAuxWindowRole) => void;
  closeCurrentWindow: () => void;
  minimizeCurrentWindow: () => void;
  onWindowState: (
    callback: (state: DesktopWindowVisibilityState) => void,
  ) => () => void;
  onForceRedraw: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    ag99desktop?: Ag99DesktopApi;
    api?: Ag99DesktopApi;
  }
}

export {};
