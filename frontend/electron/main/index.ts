import { app, BrowserWindow, ipcMain } from "electron";
import { MenuManager } from "./menu-manager";
import { WindowManager } from "./window-manager";

let windowManager: WindowManager;
let menuManager: MenuManager;

function watchWindowShortcuts(window: BrowserWindow): void {
  if (!app.isPackaged) {
    window.webContents.on(
      "render-process-gone",
      (_event, details) => {
        console.error(`[renderer] process gone: ${details.reason}`);
      },
    );

    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL) => {
        console.error(
          `[renderer] load failed: ${errorCode} ${errorDescription} ${validatedURL}`,
        );
      },
    );
  }

  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") {
      return;
    }

    const isReloadShortcut =
      input.code === "KeyR" && (input.control || input.meta);
    if (isReloadShortcut && app.isPackaged) {
      event.preventDefault();
      return;
    }

    if (!app.isPackaged && input.code === "F12") {
      if (window.webContents.isDevToolsOpened()) {
        window.webContents.closeDevTools();
      } else {
        window.webContents.openDevTools({ mode: "detach" });
      }
    }
  });
}

function setupIpc(): void {
  ipcMain.on("desktop:toggle-aux-window", (_event, target) => {
    if (target === "settings" || target === "history") {
      windowManager.toggleAuxWindow(target);
    }
  });

  ipcMain.on("desktop:close-current-window", (event) => {
    windowManager.closeCurrentWindow(BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.on("desktop:minimize-current-window", (event) => {
    windowManager.minimizeCurrentWindow(BrowserWindow.fromWebContents(event.sender));
  });
}

app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId("ag99live.desktop");
  }

  app.on("browser-window-created", (_, window) => {
    watchWindowShortcuts(window);
  });

  windowManager = new WindowManager();
  menuManager = new MenuManager(windowManager);
  void menuManager;
  windowManager.createWindows();
  setupIpc();

  app.on("activate", () => {
    if (!windowManager.getWindow("pet")) {
      windowManager.createWindows();
      return;
    }

    windowManager.getWindow("pet")?.show();
  });

});

app.on("before-quit", () => {
  windowManager?.markAppQuitting();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
