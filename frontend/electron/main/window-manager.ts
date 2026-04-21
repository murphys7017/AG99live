import { app, BrowserWindow, screen, shell } from "electron";
import path from "node:path";
import type { Event as ElectronEvent } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import type { Rectangle } from "electron";
import type {
  DesktopAuxWindowRole,
  DesktopWindowRole,
  DesktopWindowVisibilityState,
} from "../../src/types/desktop";

type ManagedWindowMap = Record<DesktopWindowRole, BrowserWindow | null>;

interface WindowDragState {
  targetWindow: BrowserWindow;
  offsetX: number;
  offsetY: number;
  lockedWidth: number;
  lockedHeight: number;
}

interface TransparentWindowSnapshot {
  petBounds: Rectangle | null;
  overlayBounds: Rectangle | null;
  petVisible: boolean;
  overlayVisible: boolean;
  overlayVisiblePreference: boolean;
  petIgnoreMouseEvents: boolean;
}

const PET_WINDOW_WIDTH = 540;
const PET_WINDOW_HEIGHT = 820;
const PET_WINDOW_MARGIN = 24;
const PET_OVERLAY_WIDTH = 440;
const PET_OVERLAY_HEIGHT = 210;
const PET_OVERLAY_GAP = 18;
const WIN32_TRANSPARENT_WINDOW_COMPAT_OPTIONS: BrowserWindowConstructorOptions =
  process.platform === "win32"
    ? {
        thickFrame: false,
        roundedCorners: false,
      }
    : {};

function isDevelopment(): boolean {
  return !app.isPackaged || Boolean(process.env.ELECTRON_RENDERER_URL);
}

export class WindowManager {
  private isAppQuitting = false;
  private overlayVisiblePreference = true;
  private activeDragState: WindowDragState | null = null;
  private petWindowIgnoreMouseEvents = true;

  private windows: ManagedWindowMap = {
    pet: null,
    overlay: null,
    settings: null,
    history: null,
    action_lab: null,
  };

  createWindows(): void {
    this.windows.pet = this.createPetWindow();
    this.windows.overlay = this.createOverlayWindow();
    this.windows.settings = this.ensureAuxWindow("settings");
    this.windows.history = this.ensureAuxWindow("history");
    this.windows.action_lab = this.ensureAuxWindow("action_lab");
    this.windows.pet?.show();
    if (this.overlayVisiblePreference) {
      this.windows.overlay?.show();
    }
    this.broadcastWindowState();
  }

  getWindow(role: DesktopWindowRole): BrowserWindow | null {
    return this.windows[role];
  }

  getAuxWindow(role: DesktopAuxWindowRole): BrowserWindow | null {
    return this.windows[role];
  }

  getOverlayWindow(): BrowserWindow | null {
    return this.windows.overlay;
  }

  markAppQuitting(): void {
    this.isAppQuitting = true;
  }

  recoverTransparentWindows(reason: string): boolean {
    const petWindow = this.windows.pet;
    const overlayWindow = this.windows.overlay;
    const hasPetWindow = Boolean(petWindow && !petWindow.isDestroyed());
    const hasOverlayWindow = Boolean(overlayWindow && !overlayWindow.isDestroyed());

    if (!hasPetWindow && !hasOverlayWindow) {
      return false;
    }

    console.warn(`[window-recovery] Recreating transparent windows (${reason})`);
    const snapshot = this.captureTransparentWindowSnapshot();

    if (hasOverlayWindow && overlayWindow) {
      this.endWindowDrag(overlayWindow);
      overlayWindow.destroy();
    }

    if (hasPetWindow && petWindow) {
      this.endWindowDrag(petWindow);
      petWindow.destroy();
    }

    const nextPetWindow = this.createPetWindow();
    const nextOverlayWindow = this.createOverlayWindow();
    this.windows.pet = nextPetWindow;
    this.windows.overlay = nextOverlayWindow;
    this.restoreTransparentWindowSnapshot(snapshot, nextPetWindow, nextOverlayWindow);
    this.broadcastWindowState();
    return true;
  }

  toggleOverlayWindow(): void {
    const target = this.windows.overlay ?? this.createOverlayWindow();
    this.windows.overlay = target;

    if (target.isVisible()) {
      this.overlayVisiblePreference = false;
      target.hide();
    } else {
      this.overlayVisiblePreference = true;
      this.positionOverlayWindow();
      target.show();
      target.focus();
    }

    this.broadcastWindowState();
  }

  toggleAuxWindow(role: DesktopAuxWindowRole): void {
    const target = this.ensureAuxWindow(role);

    if (target.isVisible()) {
      target.hide();
    } else {
      target.show();
      target.focus();
    }

    this.broadcastWindowState();
  }

  closeCurrentWindow(targetWindow: BrowserWindow | null): void {
    if (!targetWindow) {
      return;
    }

    const role = this.findRole(targetWindow);
    if (!role || role === "pet") {
      return;
    }

    targetWindow.hide();
    this.broadcastWindowState();
  }

  minimizeCurrentWindow(targetWindow: BrowserWindow | null): void {
    targetWindow?.minimize();
  }

  setIgnoreMouseEvents(targetWindow: BrowserWindow | null, ignore: boolean): void {
    const petWindow = this.windows.pet;
    if (!targetWindow || !petWindow || targetWindow !== petWindow || targetWindow.isDestroyed()) {
      return;
    }

    if (this.petWindowIgnoreMouseEvents === ignore) {
      return;
    }

    this.petWindowIgnoreMouseEvents = ignore;

    if (ignore) {
      targetWindow.setIgnoreMouseEvents(true, { forward: true });
      this.keepPetWindowPassive(targetWindow);
      return;
    }

    targetWindow.setIgnoreMouseEvents(false);
    this.keepPetWindowPassive(targetWindow);
  }

  startWindowDrag(
    targetWindow: BrowserWindow | null,
    screenX: number,
    screenY: number,
  ): void {
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }

    const bounds = targetWindow.getBounds();
    const role = this.findRole(targetWindow);
    const lockedWidth = role === "pet"
      ? PET_WINDOW_WIDTH
      : role === "overlay"
        ? PET_OVERLAY_WIDTH
        : bounds.width;
    const lockedHeight = role === "pet"
      ? PET_WINDOW_HEIGHT
      : role === "overlay"
        ? PET_OVERLAY_HEIGHT
        : bounds.height;
    this.activeDragState = {
      targetWindow,
      offsetX: screenX - bounds.x,
      offsetY: screenY - bounds.y,
      lockedWidth,
      lockedHeight,
    };

    if (bounds.width !== lockedWidth || bounds.height !== lockedHeight) {
      targetWindow.setBounds(
        {
          ...bounds,
          width: lockedWidth,
          height: lockedHeight,
        },
        false,
      );
    }

    targetWindow.moveTop();
  }

  updateWindowDrag(
    targetWindow: BrowserWindow | null,
    screenX: number,
    screenY: number,
  ): void {
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }

    const activeDragState = this.activeDragState;
    if (!activeDragState || activeDragState.targetWindow !== targetWindow) {
      return;
    }

    const nextX = Math.round(screenX - activeDragState.offsetX);
    const nextY = Math.round(screenY - activeDragState.offsetY);
    targetWindow.setBounds(
      {
        x: nextX,
        y: nextY,
        width: activeDragState.lockedWidth,
        height: activeDragState.lockedHeight,
      },
      false,
    );
  }

  endWindowDrag(targetWindow: BrowserWindow | null): void {
    if (!targetWindow) {
      return;
    }

    if (this.activeDragState?.targetWindow === targetWindow) {
      const activeDragState = this.activeDragState;
      const bounds = targetWindow.isDestroyed() ? null : targetWindow.getBounds();
      if (
        bounds
        && (
          bounds.width !== activeDragState.lockedWidth
          || bounds.height !== activeDragState.lockedHeight
        )
      ) {
        targetWindow.setBounds(
          {
            ...bounds,
            width: activeDragState.lockedWidth,
            height: activeDragState.lockedHeight,
          },
          false,
        );
      }
      this.activeDragState = null;
    }
  }

  buildWindowState(): DesktopWindowVisibilityState {
    return {
      petVisible: Boolean(this.windows.pet?.isVisible()),
      overlayVisible: Boolean(this.windows.overlay?.isVisible()),
      settingsVisible: Boolean(this.windows.settings?.isVisible()),
      historyVisible: Boolean(this.windows.history?.isVisible()),
      actionLabVisible: Boolean(this.windows.action_lab?.isVisible()),
    };
  }

  broadcastWindowState(): void {
    const payload = this.buildWindowState();
    for (const currentWindow of Object.values(this.windows)) {
      currentWindow?.webContents.send("desktop-window-state", payload);
    }
  }

  private keepPetWindowPassive(targetWindow: BrowserWindow): void {
    if (targetWindow.isDestroyed() || targetWindow.webContents.isDevToolsOpened()) {
      return;
    }

    targetWindow.setFocusable(false);
  }

  private createPetWindow(): BrowserWindow {
    const petWindow = new BrowserWindow({
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
      title: "",
      frame: false,
      transparent: true,
      show: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      resizable: false,
      maximizable: false,
      minimizable: true,
      alwaysOnTop: true,
      focusable: false,
      webPreferences: {
        preload: this.resolvePreloadPath(),
        contextIsolation: true,
        sandbox: false,
      },
      ...WIN32_TRANSPARENT_WINDOW_COMPAT_OPTIONS,
    });

    petWindow.setAlwaysOnTop(true, "screen-saver");
    if (process.platform === "darwin") {
      petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    petWindow.setMenuBarVisibility(false);
    this.petWindowIgnoreMouseEvents = true;
    petWindow.setIgnoreMouseEvents(true, { forward: true });
    this.keepPetWindowPassive(petWindow);
    petWindow.setPosition(
      screen.getPrimaryDisplay().workArea.x
        + screen.getPrimaryDisplay().workArea.width
        - PET_WINDOW_WIDTH
        - PET_WINDOW_MARGIN,
      screen.getPrimaryDisplay().workArea.y
        + screen.getPrimaryDisplay().workArea.height
        - PET_WINDOW_HEIGHT
        - PET_WINDOW_MARGIN,
    );

    petWindow.on("show", () => {
      this.petWindowIgnoreMouseEvents = true;
      petWindow.setIgnoreMouseEvents(true, { forward: true });
      this.keepPetWindowPassive(petWindow);
      if (this.overlayVisiblePreference) {
        this.windows.overlay?.show();
      }
      this.positionOverlayWindow();
      this.broadcastWindowState();
    });
    petWindow.on("hide", () => {
      this.windows.overlay?.hide();
      this.broadcastWindowState();
    });
    petWindow.on("move", () => {
      this.positionOverlayWindow();
    });
    petWindow.on("resize", () => {
      this.positionOverlayWindow();
    });
    petWindow.on("closed", () => {
      this.endWindowDrag(petWindow);
      this.windows.pet = null;
    });

    this.attachExternalLinkGuard(petWindow);
    this.loadWindow(petWindow, "pet");
    return petWindow;
  }

  private createOverlayWindow(): BrowserWindow {
    const workArea = screen.getPrimaryDisplay().workArea;
    const overlayWindow = new BrowserWindow({
      width: PET_OVERLAY_WIDTH,
      height: PET_OVERLAY_HEIGHT,
      title: "",
      frame: false,
      transparent: true,
      show: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      resizable: false,
      maximizable: false,
      minimizable: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: this.resolvePreloadPath(),
        contextIsolation: true,
        sandbox: false,
      },
      ...WIN32_TRANSPARENT_WINDOW_COMPAT_OPTIONS,
    });

    overlayWindow.setAlwaysOnTop(true, "screen-saver");
    if (process.platform === "darwin") {
      overlayWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      });
    }
    overlayWindow.setMenuBarVisibility(false);
    overlayWindow.setPosition(
      Math.max(workArea.x + workArea.width - PET_OVERLAY_WIDTH - PET_WINDOW_MARGIN, workArea.x + PET_WINDOW_MARGIN),
      Math.max(workArea.y + workArea.height - PET_OVERLAY_HEIGHT - PET_WINDOW_MARGIN, workArea.y + PET_WINDOW_MARGIN),
    );

    overlayWindow.on("show", () => {
      this.overlayVisiblePreference = true;
      this.broadcastWindowState();
    });
    overlayWindow.on("hide", () => {
      this.broadcastWindowState();
    });
    overlayWindow.on("close", (event: ElectronEvent) => {
      if (this.isAppQuitting) {
        return;
      }

      event.preventDefault();
      this.overlayVisiblePreference = false;
      overlayWindow.hide();
    });
    overlayWindow.on("closed", () => {
      this.endWindowDrag(overlayWindow);
      this.windows.overlay = null;
    });

    this.attachExternalLinkGuard(overlayWindow);
    this.loadWindow(overlayWindow, "overlay");
    this.positionOverlayWindow();
    return overlayWindow;
  }

  private createUtilityWindow(role: DesktopAuxWindowRole): BrowserWindow {
    const title = role === "settings"
      ? "AG99live Settings"
      : role === "history"
        ? "AG99live History"
        : "AG99live Action Lab";
    const width = role === "settings" ? 520 : role === "history" ? 480 : 940;
    const height = role === "settings" ? 700 : role === "history" ? 680 : 760;
    const utilityWindow = new BrowserWindow({
      width,
      height,
      show: false,
      title,
      autoHideMenuBar: true,
      backgroundColor: "#f4f6fb",
      webPreferences: {
        preload: this.resolvePreloadPath(),
        contextIsolation: true,
        sandbox: false,
      },
    });

    utilityWindow.on("close", (event: ElectronEvent) => {
      if (this.isAppQuitting) {
        return;
      }

      event.preventDefault();
      utilityWindow.hide();
    });
    utilityWindow.on("hide", () => {
      this.broadcastWindowState();
    });
    utilityWindow.on("show", () => {
      this.broadcastWindowState();
    });
    utilityWindow.on("closed", () => {
      this.endWindowDrag(utilityWindow);
      this.windows[role] = null;
    });

    this.attachExternalLinkGuard(utilityWindow);
    this.loadWindow(utilityWindow, role);
    return utilityWindow;
  }

  private ensureAuxWindow(role: DesktopAuxWindowRole): BrowserWindow {
    const currentWindow = this.windows[role];
    if (currentWindow && !currentWindow.isDestroyed()) {
      return currentWindow;
    }

    const nextWindow = this.createUtilityWindow(role);
    this.windows[role] = nextWindow;
    return nextWindow;
  }

  private attachExternalLinkGuard(targetWindow: BrowserWindow): void {
    targetWindow.webContents.setWindowOpenHandler((details) => {
      void shell.openExternal(details.url);
      return { action: "deny" };
    });
  }

  private loadWindow(targetWindow: BrowserWindow, role: DesktopWindowRole): void {
    if (isDevelopment() && process.env.ELECTRON_RENDERER_URL) {
      const url = new URL(process.env.ELECTRON_RENDERER_URL);
      url.searchParams.set("window", role);
      void targetWindow.loadURL(url.toString());
      return;
    }

    void targetWindow.loadFile(path.resolve(__dirname, "../renderer/index.html"), {
      search: `window=${role}`,
    });
  }

  private findRole(targetWindow: BrowserWindow): DesktopWindowRole | null {
    for (const [role, currentWindow] of Object.entries(this.windows)) {
      if (currentWindow === targetWindow) {
        return role as DesktopWindowRole;
      }
    }
    return null;
  }

  private resolvePreloadPath(): string {
    return path.resolve(__dirname, "../preload/index.cjs");
  }

  private captureTransparentWindowSnapshot(): TransparentWindowSnapshot {
    const petWindow = this.windows.pet;
    const overlayWindow = this.windows.overlay;

    return {
      petBounds: petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null,
      overlayBounds: overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow.getBounds() : null,
      petVisible: Boolean(petWindow?.isVisible()),
      overlayVisible: Boolean(overlayWindow?.isVisible()),
      overlayVisiblePreference: this.overlayVisiblePreference,
      petIgnoreMouseEvents: this.petWindowIgnoreMouseEvents,
    };
  }

  private restoreTransparentWindowSnapshot(
    snapshot: TransparentWindowSnapshot,
    petWindow: BrowserWindow,
    overlayWindow: BrowserWindow,
  ): void {
    this.overlayVisiblePreference = snapshot.overlayVisiblePreference;
    this.petWindowIgnoreMouseEvents = snapshot.petIgnoreMouseEvents;

    if (snapshot.petBounds) {
      petWindow.setBounds(snapshot.petBounds, false);
    }

    if (snapshot.overlayBounds) {
      overlayWindow.setBounds(snapshot.overlayBounds, false);
    } else {
      this.positionOverlayWindow();
    }

    if (this.petWindowIgnoreMouseEvents) {
      petWindow.setIgnoreMouseEvents(true, { forward: true });
      this.keepPetWindowPassive(petWindow);
    } else {
      petWindow.setIgnoreMouseEvents(false);
    }

    if (snapshot.petVisible) {
      petWindow.show();
    } else {
      petWindow.hide();
    }

    const shouldShowOverlay = snapshot.petVisible
      && snapshot.overlayVisible
      && snapshot.overlayVisiblePreference;

    if (shouldShowOverlay) {
      overlayWindow.show();
    } else {
      overlayWindow.hide();
    }
  }

  private positionOverlayWindow(): void {
    const petWindow = this.windows.pet;
    const overlayWindow = this.windows.overlay;

    if (!petWindow || petWindow.isDestroyed() || !overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    const petBounds = petWindow.getBounds();
    const display = screen.getDisplayMatching(petBounds);
    const workArea = display.workArea;
    const overlayBounds = overlayWindow.getBounds();
    const overlayWidth = PET_OVERLAY_WIDTH;
    const overlayHeight = PET_OVERLAY_HEIGHT;

    let x = petBounds.x - overlayWidth - PET_OVERLAY_GAP;
    if (x < workArea.x + PET_WINDOW_MARGIN) {
      x = petBounds.x + petBounds.width + PET_OVERLAY_GAP;
    }

    const maxX = workArea.x + workArea.width - overlayWidth - PET_WINDOW_MARGIN;
    const minX = workArea.x + PET_WINDOW_MARGIN;
    x = Math.min(Math.max(x, minX), maxX);

    let y = petBounds.y + petBounds.height - overlayHeight - 28;
    const maxY = workArea.y + workArea.height - overlayHeight - PET_WINDOW_MARGIN;
    const minY = workArea.y + PET_WINDOW_MARGIN;
    y = Math.min(Math.max(y, minY), maxY);

    const targetX = Math.round(x);
    const targetY = Math.round(y);
    if (
      overlayBounds.x !== targetX
      || overlayBounds.y !== targetY
      || overlayBounds.width !== overlayWidth
      || overlayBounds.height !== overlayHeight
    ) {
      overlayWindow.setBounds(
        {
          x: targetX,
          y: targetY,
          width: overlayWidth,
          height: overlayHeight,
        },
        false,
      );
    }
  }
}
