import type {
  DesktopAuxWindowRole,
  DesktopWindowVisibilityState,
} from "./desktop";

export interface Ag99DesktopApi {
  showContextMenu: () => void;
  getLocalAdapterHosts: () => string[];
  toggleAuxWindow: (target: DesktopAuxWindowRole) => void;
  closeCurrentWindow: () => void;
  minimizeCurrentWindow: () => void;
  onWindowState: (
    callback: (state: DesktopWindowVisibilityState) => void,
  ) => () => void;
}

declare global {
  interface Window {
    ag99desktop?: Ag99DesktopApi;
  }
}

export {};
