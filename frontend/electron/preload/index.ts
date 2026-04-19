import { contextBridge, ipcRenderer } from "electron";
import os from "node:os";
import type {
  DesktopAuxWindowRole,
  DesktopWindowVisibilityState,
} from "../../src/types/desktop";

function listLocalAdapterHosts(): string[] {
  const ordered = ["127.0.0.1", "localhost"];
  const seen = new Set(ordered.map((value) => value.toLowerCase()));

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = String(entry.family);
      if ((family !== "IPv4" && family !== "4") || entry.internal || !entry.address) {
        continue;
      }

      const address = entry.address.trim();
      if (!address || seen.has(address.toLowerCase())) {
        continue;
      }

      seen.add(address.toLowerCase());
      ordered.push(address);
    }
  }

  return ordered;
}

const api = {
  showContextMenu: () => {
    ipcRenderer.send("desktop:show-context-menu");
  },
  getLocalAdapterHosts: () => {
    return listLocalAdapterHosts();
  },
  toggleAuxWindow: (target: DesktopAuxWindowRole) => {
    ipcRenderer.send("desktop:toggle-aux-window", target);
  },
  closeCurrentWindow: () => {
    ipcRenderer.send("desktop:close-current-window");
  },
  minimizeCurrentWindow: () => {
    ipcRenderer.send("desktop:minimize-current-window");
  },
  onWindowState: (
    callback: (state: DesktopWindowVisibilityState) => void,
  ) => {
    const handler = (_event: unknown, state: DesktopWindowVisibilityState) => {
      callback(state);
    };

    ipcRenderer.on("desktop-window-state", handler);
    return () => {
      ipcRenderer.removeListener("desktop-window-state", handler);
    };
  },
};

const hasContextIsolation = Boolean(
  (process as NodeJS.Process & { contextIsolated?: boolean }).contextIsolated,
);

if (hasContextIsolation) {
  contextBridge.exposeInMainWorld("ag99desktop", api);
} else {
  const target = window as Window & {
    ag99desktop?: typeof api;
  };
  target.ag99desktop = api;
}
