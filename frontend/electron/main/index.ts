import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session } from "electron";
import { MenuManager } from "./menu-manager";
import { WindowManager } from "./window-manager";
import { setupNativeMicrophoneIpc } from "./native-microphone";
import { registerEsp32DisplayIpc, shutdownEsp32DisplayBridge } from "./esp32-display-bridge";
import { registerBilibiliLiveIpc } from "./bilibili-live-bridge";
import type {
  DesktopPttEventAck,
  DesktopPttEventKind,
  DesktopPttEventPayload,
  DesktopPttHookStatus,
  DesktopPttKeyBinding,
} from "../../src/types/desktop";

let windowManager: WindowManager;
let menuManager: MenuManager;
const WM_DWMCOMPOSITIONCHANGED = 0x031e;
const WINDOW_RECOVERY_DEBOUNCE_MS = 5000;

app.commandLine.appendSwitch("enable-media-stream");

// ── Global keyboard hook for PTT ───────────────────────────────────

let uiohookModule: Record<string, unknown> | null = null;
let globalPttEnabled = false;
let globalPttKeycode: number | null = 29;
let globalPttHookStarted = false;
let globalPttListenersInstalled = false;
let globalPttListenerGeneration = 0;
let globalPttPressed = false;
let globalPttEventSerial = 0;
let lastPttHookStatus: DesktopPttHookStatus = buildPttHookStatus({
  available: true,
  enabled: false,
  keycode: globalPttKeycode,
  reason: "",
});
const recentPttEvents = new Map<string, DesktopPttEventPayload>();
const MAX_RECENT_PTT_EVENTS = 20;

interface UiohookController {
  on: (event: string, callback: (event: { keycode: number }) => void) => void;
  start: () => void;
  stop: () => void;
}

function loadUiohook(): Record<string, unknown> | null {
  if (uiohookModule) {
    return uiohookModule;
  }
  try {
    uiohookModule = require("uiohook-napi");
  } catch (err) {
    const reason = err instanceof Error ? err.message : "uiohook_unavailable";
    console.warn("[PTT] uiohook-napi unavailable, global PTT disabled.", err);
    uiohookModule = null;
    publishPttHookStatus({
      available: false,
      enabled: false,
      keycode: globalPttKeycode,
      reason,
    });
  }
  return uiohookModule;
}

function resolveUiohookController(uiohook: Record<string, unknown>): UiohookController | null {
  const hook = uiohook.uIOhook;
  if (!hook || typeof hook !== "object") {
    publishPttHookFailure("uiohook_invalid_export");
    return null;
  }

  const maybeHook = hook as Partial<UiohookController>;
  if (
    typeof maybeHook.on !== "function"
    || typeof maybeHook.start !== "function"
    || typeof maybeHook.stop !== "function"
  ) {
    publishPttHookFailure("uiohook_invalid_controller");
    return null;
  }

  return maybeHook as UiohookController;
}

function startGlobalPttHook(): void {
  if (!globalPttKeycode) {
    console.warn("[PTT] global keyboard hook disabled for unmapped key binding.");
    publishPttHookStatus({
      available: false,
      enabled: false,
      keycode: null,
      reason: "unmapped_key_binding",
    });
    return;
  }
  const uiohook = loadUiohook();
  if (!uiohook) {
    return;
  }
  globalPttEnabled = true;
  if (globalPttHookStarted) {
    publishPttHookStatus({
      available: true,
      enabled: true,
      keycode: globalPttKeycode,
      reason: "",
    });
    return;
  }
  const hook = resolveUiohookController(uiohook);
  if (!hook) {
    globalPttEnabled = false;
    return;
  }
  if (!globalPttListenersInstalled) {
    const listenerGeneration = ++globalPttListenerGeneration;
    try {
      hook.on("keydown", (event) => {
        if (listenerGeneration !== globalPttListenerGeneration) return;
        if (!globalPttEnabled) return;
        if (event.keycode === globalPttKeycode) {
          if (globalPttPressed) return;
          globalPttPressed = true;
          sendGlobalPttEvent("keydown", event.keycode);
        }
      });
      hook.on("keyup", (event) => {
        if (listenerGeneration !== globalPttListenerGeneration) return;
        if (!globalPttEnabled) return;
        if (event.keycode === globalPttKeycode) {
          globalPttPressed = false;
          sendGlobalPttEvent("keyup", event.keycode);
        }
      });
      globalPttListenersInstalled = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "uiohook_listener_registration_failed";
      console.warn("[PTT] failed to register global keyboard listeners.", err);
      globalPttEnabled = false;
      globalPttListenerGeneration += 1;
      publishPttHookFailure(reason);
      return;
    }
  }
  try {
    hook.start();
    globalPttHookStarted = true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : "uiohook_start_failed";
    console.warn("[PTT] failed to start global keyboard hook.", err);
    globalPttEnabled = false;
    publishPttHookStatus({
      available: false,
      enabled: false,
      keycode: globalPttKeycode,
      reason,
    });
    return;
  }
  publishPttHookStatus({
    available: true,
    enabled: true,
    keycode: globalPttKeycode,
    reason: "",
  });
  console.info("[PTT] global keyboard hook started");
}

function stopGlobalPttHook(): void {
  const uiohook = uiohookModule;
  globalPttEnabled = false;
  globalPttPressed = false;
  if (!uiohook) {
    publishPttHookStatus({
      available: false,
      enabled: false,
      keycode: globalPttKeycode,
      reason: lastPttHookStatus.reason || "uiohook_unavailable",
    });
    return;
  }
  const hook = resolveUiohookController(uiohook);
  if (!hook) {
    return;
  }
  if (!globalPttHookStarted) {
    publishPttHookStatus({
      available: true,
      enabled: false,
      keycode: globalPttKeycode,
      reason: "",
    });
    return;
  }
  try {
    hook.stop();
    globalPttHookStarted = false;
  } catch (err) {
    console.warn("[PTT] failed to stop global keyboard hook.", err);
  }
  publishPttHookStatus({
    available: true,
    enabled: false,
    keycode: globalPttKeycode,
    reason: "",
  });
  console.info("[PTT] global keyboard hook stopped");
}

function buildPttHookStatus(
  input: Omit<DesktopPttHookStatus, "updatedAt">,
): DesktopPttHookStatus {
  return {
    ...input,
    updatedAt: new Date().toISOString(),
  };
}

function publishPttHookStatus(
  input: Omit<DesktopPttHookStatus, "updatedAt">,
): void {
  lastPttHookStatus = buildPttHookStatus(input);
  broadcastToAllWindows("desktop:ptt-hook-status", lastPttHookStatus);
}

function publishPttHookFailure(reason: string): void {
  publishPttHookStatus({
    available: false,
    enabled: false,
    keycode: globalPttKeycode,
    reason,
  });
}

function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const currentWindow of BrowserWindow.getAllWindows()) {
    if (!currentWindow.isDestroyed()) {
      currentWindow.webContents.send(channel, payload);
    }
  }
}

function normalizePttKeycode(binding: unknown): number | null {
  if (!binding || typeof binding !== "object") {
    return 29;
  }

  const keycode = (binding as Partial<DesktopPttKeyBinding>).uiohookKeycode;
  return typeof keycode === "number" && Number.isInteger(keycode) && keycode > 0
    ? keycode
    : null;
}

function sendGlobalPttEvent(kind: DesktopPttEventKind, keycode: number): void {
  const pet = windowManager?.getWindow("pet");
  const payload: DesktopPttEventPayload = {
    eventId: `ptt:${Date.now()}:${++globalPttEventSerial}`,
    kind,
    keycode,
    createdAt: new Date().toISOString(),
  };
  recentPttEvents.set(payload.eventId, payload);
  trimRecentPttEvents();

  const ready = Boolean(pet && !pet.isDestroyed());
  console.info(
    "[PTT] global %s matched keycode=%s event=%s petReady=%s",
    kind,
    keycode,
    payload.eventId,
    ready,
  );

  if (!pet || pet.isDestroyed()) {
    console.warn("[PTT] event=%s not delivered: pet window unavailable", payload.eventId);
    return;
  }

  pet.webContents.send(`desktop:ptt-${kind}`, payload);
}

function trimRecentPttEvents(): void {
  while (recentPttEvents.size > MAX_RECENT_PTT_EVENTS) {
    const oldest = recentPttEvents.keys().next().value;
    if (!oldest) {
      return;
    }
    recentPttEvents.delete(oldest);
  }
}

function recordPttAck(ack: unknown): void {
  if (!isDesktopPttEventAck(ack)) {
    console.warn("[PTT] ignored malformed ack", ack);
    return;
  }

  const eventPayload = recentPttEvents.get(ack.eventId);
  const latencyMs = eventPayload
    ? Date.now() - Date.parse(eventPayload.createdAt)
    : null;
  console.info(
    "[PTT] ack event=%s kind=%s status=%s latencyMs=%s message=%s",
    ack.eventId,
    ack.kind,
    ack.status,
    latencyMs ?? "unknown",
    ack.message ?? "",
  );

  if (ack.status !== "received") {
    recentPttEvents.delete(ack.eventId);
  }
}

function isDesktopPttEventAck(value: unknown): value is DesktopPttEventAck {
  if (!value || typeof value !== "object") {
    return false;
  }

  const raw = value as Partial<DesktopPttEventAck>;
  return (
    typeof raw.eventId === "string"
    && (raw.kind === "keydown" || raw.kind === "keyup")
    && (
      raw.status === "received"
      || raw.status === "started"
      || raw.status === "stopped"
      || raw.status === "discarded"
      || raw.status === "ignored"
      || raw.status === "failed"
    )
    && typeof raw.timestamp === "string"
  );
}

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

  ipcMain.on("desktop:set-ptt-mode", (_event, enabled: boolean, binding?: DesktopPttKeyBinding) => {
    globalPttKeycode = normalizePttKeycode(binding);
    globalPttPressed = false;
    console.info("[PTT] set mode enabled=%s keycode=%s", Boolean(enabled), globalPttKeycode ?? "unmapped");
    windowManager.setPetWindowFocusEnabled(enabled);
    if (enabled) {
      if (globalPttKeycode) {
        startGlobalPttHook();
      } else {
        stopGlobalPttHook();
      }
    } else {
      stopGlobalPttHook();
    }
  });

  ipcMain.handle("desktop:get-ptt-hook-status", async () => lastPttHookStatus);

  ipcMain.on("desktop:ptt-event-ack", (_event, ack: unknown) => {
    recordPttAck(ack);
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

function setupMediaPermissions(): void {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    if (permission !== "media") {
      return false;
    }

    return isAudioMediaPermissionCheck(details);
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission !== "media") {
      callback(false);
      return;
    }

    callback(isAudioOnlyMediaRequest(details));
  });
}

function getRequestedMediaTypes(details: unknown): string[] {
  if (!details || typeof details !== "object") {
    return [];
  }

  const mediaTypes = (details as { mediaTypes?: unknown }).mediaTypes;
  return Array.isArray(mediaTypes)
    ? mediaTypes.filter((item): item is string => typeof item === "string")
    : [];
}

function getRequestedMediaType(details: unknown): string {
  if (!details || typeof details !== "object") {
    return "";
  }

  const mediaType = (details as { mediaType?: unknown }).mediaType;
  return typeof mediaType === "string" ? mediaType : "";
}

function isAudioMediaPermissionCheck(details: unknown): boolean {
  const mediaType = getRequestedMediaType(details);
  return mediaType === "audio" || mediaType === "unknown" || mediaType === "";
}

function isAudioOnlyMediaRequest(details: unknown): boolean {
  const mediaTypes = getRequestedMediaTypes(details);
  if (mediaTypes.length > 0) {
    return mediaTypes.includes("audio") && !mediaTypes.includes("video");
  }

  const mediaType = getRequestedMediaType(details);
  return mediaType === "audio";
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
  setupMediaPermissions();
  app.on("browser-window-created", (_, window) => {
    watchWindowShortcuts(window);
    attachRecoveryHook(window);
  });

  windowManager = new WindowManager();
  menuManager = new MenuManager(windowManager);
  void menuManager;
  windowManager.createWindows();
  setupIpc();
  setupNativeMicrophoneIpc();
  registerEsp32DisplayIpc();
  registerBilibiliLiveIpc();

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
  void shutdownEsp32DisplayBridge();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
