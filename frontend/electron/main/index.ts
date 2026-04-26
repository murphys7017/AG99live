import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } from "electron";
import { MenuManager } from "./menu-manager";
import { WindowManager } from "./window-manager";

let windowManager: WindowManager;
let menuManager: MenuManager;
const WM_DWMCOMPOSITIONCHANGED = 0x031e;
const WINDOW_RECOVERY_DEBOUNCE_MS = 5000;

function isEnvFlagEnabled(name: string): boolean {
  const raw = process.env[name];
  if (!raw) {
    return false;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

if (process.platform === "win32") {
  if (isEnvFlagEnabled("AG99_DISABLE_DIRECT_COMPOSITION")) {
    app.commandLine.appendSwitch("disable-direct-composition");
  }

  // Keep GPU enabled by default to avoid heavy CPU fallback rendering.
  // Enable this only when explicitly diagnosing transparent window artifacts.
  if (isEnvFlagEnabled("AG99_DISABLE_GPU")) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("disable-gpu");
    app.commandLine.appendSwitch("disable-gpu-compositing");
  }
}

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

    if (!app.isPackaged && (input.code === "F12" || (input.code === "KeyI" && input.control && input.shift))) {
      event.preventDefault();
      if (window.webContents.isDevToolsOpened()) {
        window.webContents.closeDevTools();
      } else {
        window.webContents.openDevTools({ mode: "detach" });
      }
      return;
    }
    if (!app.isPackaged && input.code === "F5") {
      event.preventDefault();
      window.webContents.reload();
      return;
    }
  });
}

function setupIpc(): void {
  ipcMain.on("desktop:toggle-aux-window", (_event, target) => {
    if (
      target === "settings"
      || target === "history"
      || target === "action_lab"
      || target === "profile_editor"
    ) {
      windowManager.toggleAuxWindow(target);
    }
  });

  ipcMain.on("desktop:close-current-window", (event) => {
    windowManager.closeCurrentWindow(BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.on("desktop:minimize-current-window", (event) => {
    windowManager.minimizeCurrentWindow(BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.on("desktop:set-overlay-content-height", (event, height) => {
    windowManager.setOverlayContentHeight(
      BrowserWindow.fromWebContents(event.sender),
      Number(height),
    );
  });

  ipcMain.on("desktop:set-ignore-mouse-events", (event, ignore) => {
    windowManager.setIgnoreMouseEvents(
      BrowserWindow.fromWebContents(event.sender),
      Boolean(ignore),
    );
  });

  ipcMain.on("desktop:start-window-drag", (event, screenX, screenY) => {
    windowManager.startWindowDrag(
      BrowserWindow.fromWebContents(event.sender),
      screenX,
      screenY,
    );
  });

  ipcMain.on("desktop:update-window-drag", (event, screenX, screenY) => {
    windowManager.updateWindowDrag(
      BrowserWindow.fromWebContents(event.sender),
      screenX,
      screenY,
    );
  });

  ipcMain.on("desktop:end-window-drag", (event) => {
    windowManager.endWindowDrag(BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.handle("desktop:capture-screen-image", async () => {
    const primaryDisplayId = String(screen.getPrimaryDisplay().id);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1280, height: 720 },
      fetchWindowIcons: false,
    });
    const selectedSource = sources.find((source) => source.display_id === primaryDisplayId)
      ?? sources[0]
      ?? null;

    if (!selectedSource || selectedSource.thumbnail.isEmpty()) {
      return null;
    }

    const jpegBuffer = selectedSource.thumbnail.toJPEG(76);
    return {
      data: `data:image/jpeg;base64,${jpegBuffer.toString("base64")}`,
      mime_type: "image/jpeg",
      source: "screen",
      captured_at: new Date().toISOString(),
    };
  });
}

function setupTransparentWindowRecovery(): (window: BrowserWindow) => void {
  if (
    process.platform !== "win32"
    || isEnvFlagEnabled("AG99_DISABLE_WINDOW_RECOVERY")
    || isEnvFlagEnabled("AG99_DISABLE_GPU")
  ) {
    return () => {
      // No-op recovery hook on unsupported platforms or when disabled by env.
    };
  }

  let lastRecoveryAt = 0;
  const recoverTransparentWindows = (reason: string): void => {
    if (!windowManager) {
      return;
    }

    const now = Date.now();
    if (now - lastRecoveryAt < WINDOW_RECOVERY_DEBOUNCE_MS) {
      return;
    }

    const didRecover = windowManager.recoverTransparentWindows(reason);
    if (!didRecover) {
      return;
    }

    lastRecoveryAt = now;
    console.warn(`[window-recovery] Triggered: ${reason}`);
  };

  app.on("child-process-gone", (_event, details) => {
    const processType = String(details?.type ?? "").toLowerCase();
    if (!processType.includes("gpu")) {
      return;
    }
    recoverTransparentWindows(`GPU process gone (${processType})`);
  });

  app.on("gpu-info-update", () => {
    const status = app.getGPUFeatureStatus();
    const gpuCompositingStatus = String(status.gpu_compositing ?? "").toLowerCase();
    if (gpuCompositingStatus !== "disabled") {
      return;
    }
    recoverTransparentWindows("GPU compositing disabled");
  });

  return (window: BrowserWindow) => {
    if (window.isDestroyed()) {
      return;
    }

    try {
      window.hookWindowMessage(WM_DWMCOMPOSITIONCHANGED, () => {
        recoverTransparentWindows("DWM composition changed");
      });
    } catch (error) {
      console.warn("[window-recovery] Failed to hook DWM composition change", error);
      return;
    }

    window.once("closed", () => {
      try {
        window.unhookWindowMessage(WM_DWMCOMPOSITIONCHANGED);
      } catch {
        // Ignore if the native window handle is already unavailable.
      }
    });
  };
}

app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId("ag99live.desktop");
  }

  const attachRecoveryHook = setupTransparentWindowRecovery();
  app.on("browser-window-created", (_, window) => {
    watchWindowShortcuts(window);
    attachRecoveryHook(window);
  });

  windowManager = new WindowManager();
  menuManager = new MenuManager(windowManager);
  void menuManager;
  windowManager.createWindows();
  setupIpc();

  if (!app.isPackaged) {
    globalShortcut.register("CommandOrControl+Shift+L", () => {
      const focused = BrowserWindow.getFocusedWindow();
      const target = focused ?? windowManager.getWindow("pet") ?? windowManager.getWindow("history");
      if (target && !target.isDestroyed()) {
        if (target.webContents.isDevToolsOpened()) {
          target.webContents.closeDevTools();
        } else {
          target.webContents.openDevTools({ mode: "detach" });
        }
      }
    });
  }

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
