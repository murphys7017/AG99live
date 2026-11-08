import { app, BrowserWindow, screen, shell } from "electron";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  role: DesktopWindowRole | null;
  offsetX: number;
  offsetY: number;
  lockedWidth: number;
  lockedHeight: number;
  lastX: number;
  lastY: number;
}

interface TransparentWindowSnapshot {
  petBounds: Rectangle | null;
  overlayBounds: Rectangle | null;
  subtitleBounds: Rectangle | null;
  petVisible: boolean;
  overlayVisible: boolean;
  subtitleVisible: boolean;
  overlayVisiblePreference: boolean;
  subtitleVisiblePreference: boolean;
  overlayFollowsPet?: boolean;
  petIgnoreMouseEvents: boolean;
}

interface OverlayDragOrigin {
  x: number;
  y: number;
}

const PET_WINDOW_WIDTH = 540;
const PET_WINDOW_HEIGHT = 820;
export const PET_WINDOW_SIZE_PRESETS = [
  { label: "小（420 × 640）", width: 420, height: 640 },
  { label: "默认（540 × 820）", width: PET_WINDOW_WIDTH, height: PET_WINDOW_HEIGHT },
  { label: "大（720 × 1080）", width: 720, height: 1080 },
] as const;
const PET_WINDOW_TITLE = "AG99live Live2D";
const PET_WINDOW_MARGIN = 24;
const PET_OVERLAY_WIDTH = 420;
const PET_OVERLAY_HEIGHT = 168;
const PET_OVERLAY_WINDOW_TITLE = "AG99live Input";
const PET_OVERLAY_GAP = 16;
const PET_SUBTITLE_WIDTH = 760;
const PET_SUBTITLE_HEIGHT = 124;
const PET_SUBTITLE_WINDOW_TITLE = "AG99live 字幕";
const OVERLAY_DRAG_DETACH_THRESHOLD_PX = 12;
const APP_ICON_PATH = path.resolve(__dirname, "../../resources/app-icon.png");
const WIN32_TRANSPARENT_WINDOW_COMPAT_OPTIONS: BrowserWindowConstructorOptions =
  process.platform === "win32"
    ? {
        thickFrame: false,
        roundedCorners: false,
      }
    : {};
const WIN32_RESIZABLE_TRANSPARENT_WINDOW_COMPAT_OPTIONS: BrowserWindowConstructorOptions =
  process.platform === "win32"
    ? {
        // Frameless transparent windows need the native thick-frame hit area
        // for edge resizing on Windows.
        thickFrame: true,
        roundedCorners: false,
      }
    : {};

function isDevelopment(): boolean {
  return !app.isPackaged || Boolean(process.env.ELECTRON_RENDERER_URL);
}

function isSafeExternalLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export class WindowManager {
  private readonly subtitlePreferencePath: string;
  private isAppQuitting = false;
  private overlayVisiblePreference = true;
  private subtitleVisiblePreference: boolean;
  private overlayFollowsPet = true;
  private overlayDragOrigin: OverlayDragOrigin | null = null;
  private activeDragState: WindowDragState | null = null;
  private dragTimer: ReturnType<typeof setInterval> | null = null;
  private pendingTransparentWindowRecoveryReason: string | null = null;
  private petWindowIgnoreMouseEvents = true;
  private readonly rendererReadyWindows = new WeakSet<BrowserWindow>();

  constructor(userDataPath = app.getPath("userData")) {
    this.subtitlePreferencePath = path.join(userDataPath, "subtitle-preferences.json");
    this.subtitleVisiblePreference = this.loadSubtitleVisiblePreference();
  }

  private windows: ManagedWindowMap = {
    pet: null,
    overlay: null,
    subtitle: null,
    settings: null,
    history: null,
    action_lab: null,
    profile_editor: null,
  };

  createWindows(): void {
    this.windows.pet = this.createPetWindow();
    this.windows.overlay = this.createOverlayWindow();
    this.windows.subtitle = this.createSubtitleWindow();
    this.showWindowWhenReady(this.windows.pet, () => {
      this.windows.pet?.show();
    });
    this.showWindowWhenReady(this.windows.overlay, () => {
      this.showOverlayIfReady();
    });
    this.showWindowWhenReady(this.windows.subtitle, () => {
      this.showSubtitleIfReady();
    });
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

  getSubtitleWindow(): BrowserWindow | null {
    return this.windows.subtitle;
  }

  setPetWindowSize(width: number, height: number): void {
    const petWindow = this.windows.pet;
    if (
      !petWindow
      || petWindow.isDestroyed()
      || !Number.isFinite(width)
      || !Number.isFinite(height)
    ) {
      return;
    }

    const bounds = petWindow.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const nextWidth = Math.max(
      320,
      Math.min(Math.round(width), workArea.width - PET_WINDOW_MARGIN * 2),
    );
    const nextHeight = Math.max(
      480,
      Math.min(Math.round(height), workArea.height - PET_WINDOW_MARGIN * 2),
    );
    const nextX = Math.min(
      Math.max(bounds.x, workArea.x + PET_WINDOW_MARGIN),
      workArea.x + workArea.width - nextWidth - PET_WINDOW_MARGIN,
    );
    const nextY = Math.min(
      Math.max(bounds.y, workArea.y + PET_WINDOW_MARGIN),
      workArea.y + workArea.height - nextHeight - PET_WINDOW_MARGIN,
    );

    this.endWindowDrag(petWindow);
    petWindow.setBounds(
      {
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextHeight,
      },
      false,
    );
    this.positionOverlayWindow();
  }

  markAppQuitting(): void {
    this.isAppQuitting = true;
  }

  recoverTransparentWindows(reason: string): boolean {
    if (this.activeDragState) {
      this.pendingTransparentWindowRecoveryReason = reason;
      console.warn(
        `[window-recovery] Deferred while dragging transparent window (${reason})`,
      );
      return false;
    }

    const petWindow = this.windows.pet;
    const overlayWindow = this.windows.overlay;
    const subtitleWindow = this.windows.subtitle;
    const hasPetWindow = Boolean(petWindow && !petWindow.isDestroyed());
    const hasOverlayWindow = Boolean(overlayWindow && !overlayWindow.isDestroyed());
    const hasSubtitleWindow = Boolean(subtitleWindow && !subtitleWindow.isDestroyed());

    if (!hasPetWindow && !hasOverlayWindow && !hasSubtitleWindow) {
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

    if (hasSubtitleWindow && subtitleWindow) {
      this.endWindowDrag(subtitleWindow);
      subtitleWindow.destroy();
    }

    const nextPetWindow = this.createPetWindow();
    const nextOverlayWindow = this.createOverlayWindow();
    const nextSubtitleWindow = this.createSubtitleWindow();
    this.windows.pet = nextPetWindow;
    this.windows.overlay = nextOverlayWindow;
    this.windows.subtitle = nextSubtitleWindow;
    this.restoreTransparentWindowSnapshot(
      snapshot,
      nextPetWindow,
      nextOverlayWindow,
      nextSubtitleWindow,
    );
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
      if (this.overlayFollowsPet) {
        this.positionOverlayWindow();
      }
      this.showWindowWhenReady(target, () => {
        if (
          !this.overlayVisiblePreference
          || target.isDestroyed()
        ) {
          return;
        }
        target.show();
        target.focus();
      });
    }

    this.broadcastWindowState();
  }

  toggleSubtitleWindow(): void {
    const target = this.windows.subtitle ?? this.createSubtitleWindow();
    this.windows.subtitle = target;

    if (target.isVisible()) {
      this.subtitleVisiblePreference = false;
      this.persistSubtitleVisiblePreference();
      target.hide();
    } else {
      this.subtitleVisiblePreference = true;
      this.persistSubtitleVisiblePreference();
      this.showWindowWhenReady(target, () => {
        if (
          !this.subtitleVisiblePreference
          || target.isDestroyed()
        ) {
          return;
        }
        this.showSubtitleIfReady();
      });
    }

    this.broadcastWindowState();
  }

  toggleAuxWindow(role: DesktopAuxWindowRole): void {
    const target = this.ensureAuxWindow(role);

    if (target.isVisible()) {
      target.hide();
    } else {
      this.showWindowWhenReady(target, () => {
        if (target.isDestroyed()) return;
        target.show();
        target.focus();
      });
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
    const subtitleWindow = this.windows.subtitle;
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }

    if (targetWindow === subtitleWindow) {
      targetWindow.setIgnoreMouseEvents(ignore, { forward: true });
      return;
    }

    if (!petWindow || targetWindow !== petWindow) {
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

  setPetWindowFocusEnabled(enabled: boolean): void {
    const petWindow = this.windows.pet;
    if (!petWindow || petWindow.isDestroyed()) {
      return;
    }

    if (enabled) {
      // PTT mode: allow clicks and focus so keyboard events fire
      petWindow.setIgnoreMouseEvents(false);
      petWindow.setFocusable(true);
      petWindow.moveTop();
    } else {
      // Normal mode: transparent to mouse, no focus
      petWindow.setIgnoreMouseEvents(true, { forward: true });
      this.keepPetWindowPassive(petWindow);
    }
  }

  startWindowDrag(
    targetWindow: BrowserWindow | null,
    screenX: number,
    screenY: number,
  ): void {
    if (
      !targetWindow
      || targetWindow.isDestroyed()
      || !Number.isFinite(screenX)
      || !Number.isFinite(screenY)
    ) {
      return;
    }
    if (this.activeDragState) {
      this.endWindowDrag(this.activeDragState.targetWindow);
    }

    const role = this.findRole(targetWindow);
    this.normalizeTransparentWindowSize(targetWindow, role);
    const bounds = targetWindow.getBounds();
    const lockedWidth = role === "pet"
      ? bounds.width
      : role === "overlay"
        ? PET_OVERLAY_WIDTH
        : bounds.width;
    const lockedHeight = role === "pet"
      ? bounds.height
      : role === "overlay"
        ? PET_OVERLAY_HEIGHT
        : bounds.height;
    this.activeDragState = {
      targetWindow,
      role,
      offsetX: screenX - bounds.x,
      offsetY: screenY - bounds.y,
      lockedWidth,
      lockedHeight,
      lastX: bounds.x,
      lastY: bounds.y,
    };

    if (role === "overlay") {
      this.overlayDragOrigin = {
        x: bounds.x,
        y: bounds.y,
      };
    }

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
    this.dragTimer = setInterval(() => this.updateWindowDrag(), 16);
  }

  private updateWindowDrag(): void {
    const activeDragState = this.activeDragState;
    const targetWindow = activeDragState?.targetWindow;
    if (!targetWindow || targetWindow.isDestroyed()) {
      if (targetWindow) {
        this.cancelWindowDrag(targetWindow);
      }
      return;
    }

    const { x: screenX, y: screenY } = screen.getCursorScreenPoint();

    const nextX = Math.round(screenX - activeDragState.offsetX);
    const nextY = Math.round(screenY - activeDragState.offsetY);
    const deltaX = nextX - activeDragState.lastX;
    const deltaY = nextY - activeDragState.lastY;

    if (deltaX === 0 && deltaY === 0) {
      return;
    }

    targetWindow.setPosition(nextX, nextY, false);
    if (activeDragState.role === "pet") {
      this.translateOverlayWindow(deltaX, deltaY);
    } else if (
      activeDragState.role === "overlay"
      && this.overlayDragOrigin
      && this.overlayFollowsPet
    ) {
      const movedDistance = Math.hypot(
        nextX - this.overlayDragOrigin.x,
        nextY - this.overlayDragOrigin.y,
      );
      if (movedDistance >= OVERLAY_DRAG_DETACH_THRESHOLD_PX) {
        this.overlayFollowsPet = false;
      }
    }

    activeDragState.lastX = nextX;
    activeDragState.lastY = nextY;
  }

  endWindowDrag(targetWindow: BrowserWindow | null): void {
    if (!targetWindow) {
      return;
    }

    if (this.activeDragState?.targetWindow === targetWindow) {
      if (this.dragTimer !== null) {
        clearInterval(this.dragTimer);
        this.dragTimer = null;
      }
      if (targetWindow.isVisible()) {
        this.updateWindowDrag();
      }
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
      this.overlayDragOrigin = null;
      this.flushDeferredTransparentWindowRecovery();
    }
  }

  cancelWindowDrag(targetWindow: BrowserWindow | null): void {
    if (!targetWindow || this.activeDragState?.targetWindow !== targetWindow) {
      return;
    }

    if (this.dragTimer !== null) {
      clearInterval(this.dragTimer);
      this.dragTimer = null;
    }
    this.activeDragState = null;
    this.overlayDragOrigin = null;
    if (this.findRole(targetWindow) === "pet" && !targetWindow.isDestroyed()) {
      this.petWindowIgnoreMouseEvents = true;
      targetWindow.setIgnoreMouseEvents(true, { forward: true });
      this.keepPetWindowPassive(targetWindow);
    }
    this.flushDeferredTransparentWindowRecovery();
  }

  buildWindowState(): DesktopWindowVisibilityState {
    return {
      petVisible: Boolean(this.windows.pet?.isVisible()),
      overlayVisible: Boolean(this.windows.overlay?.isVisible()),
      subtitleVisible: Boolean(this.windows.subtitle?.isVisible()),
      settingsVisible: Boolean(this.windows.settings?.isVisible()),
      historyVisible: Boolean(this.windows.history?.isVisible()),
      actionLabVisible: Boolean(this.windows.action_lab?.isVisible()),
      profileEditorVisible: Boolean(this.windows.profile_editor?.isVisible()),
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
      icon: APP_ICON_PATH,
      title: PET_WINDOW_TITLE,
      frame: false,
      transparent: true,
      show: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      resizable: true,
      minWidth: 320,
      minHeight: 480,
      maximizable: false,
      minimizable: true,
      alwaysOnTop: true,
      focusable: false,
      webPreferences: {
        preload: this.resolvePreloadPath(),
        contextIsolation: true,
        sandbox: false,
      },
      ...WIN32_RESIZABLE_TRANSPARENT_WINDOW_COMPAT_OPTIONS,
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
      this.showOverlayIfReady();
      this.showSubtitleIfReady();
      if (this.overlayFollowsPet) {
        this.positionOverlayWindow();
      }
      this.broadcastWindowState();
    });
    petWindow.on("hide", () => {
      this.endWindowDrag(petWindow);
      this.windows.overlay?.hide();
      this.windows.subtitle?.hide();
      this.broadcastWindowState();
    });
    petWindow.on("move", () => {
      if (this.activeDragState?.targetWindow === petWindow) {
        return;
      }
      if (this.overlayFollowsPet) {
        this.positionOverlayWindow();
      }
    });
    petWindow.on("resize", () => {
      this.invalidateTransparentWindowSurface(petWindow);
      if (this.activeDragState?.targetWindow === petWindow) {
        return;
      }
      if (this.overlayFollowsPet) {
        this.positionOverlayWindow();
      }
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
      icon: APP_ICON_PATH,
      title: PET_OVERLAY_WINDOW_TITLE,
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
      this.endWindowDrag(overlayWindow);
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
    overlayWindow.on("resize", () => {
      this.normalizeTransparentWindowSize(overlayWindow, "overlay");
      if (this.activeDragState?.targetWindow === overlayWindow) {
        return;
      }
      if (this.overlayFollowsPet) {
        this.positionOverlayWindow();
      }
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

  private createSubtitleWindow(): BrowserWindow {
    const workArea = screen.getPrimaryDisplay().workArea;
    const subtitleWindow = new BrowserWindow({
      width: PET_SUBTITLE_WIDTH,
      height: PET_SUBTITLE_HEIGHT,
      icon: APP_ICON_PATH,
      title: PET_SUBTITLE_WINDOW_TITLE,
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

    subtitleWindow.setAlwaysOnTop(true, "screen-saver");
    if (process.platform === "darwin") {
      subtitleWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
      });
    }
    subtitleWindow.setMenuBarVisibility(false);
    subtitleWindow.setPosition(
      Math.max(
        workArea.x + Math.round((workArea.width - PET_SUBTITLE_WIDTH) / 2),
        workArea.x + PET_WINDOW_MARGIN,
      ),
      Math.max(
        workArea.y + workArea.height - PET_SUBTITLE_HEIGHT - PET_WINDOW_MARGIN,
        workArea.y + PET_WINDOW_MARGIN,
      ),
    );

    subtitleWindow.on("show", () => {
      this.subtitleVisiblePreference = true;
      this.broadcastWindowState();
    });
    subtitleWindow.on("hide", () => {
      this.endWindowDrag(subtitleWindow);
      this.broadcastWindowState();
    });
    subtitleWindow.on("close", (event: ElectronEvent) => {
      if (this.isAppQuitting) {
        return;
      }

      event.preventDefault();
      this.subtitleVisiblePreference = false;
      this.persistSubtitleVisiblePreference();
      subtitleWindow.hide();
    });
    subtitleWindow.on("resize", () => {
      this.normalizeTransparentWindowSize(subtitleWindow, "subtitle");
    });
    subtitleWindow.on("closed", () => {
      this.endWindowDrag(subtitleWindow);
      this.windows.subtitle = null;
    });

    this.attachExternalLinkGuard(subtitleWindow);
    this.loadWindow(subtitleWindow, "subtitle");
    return subtitleWindow;
  }

  private createUtilityWindow(role: DesktopAuxWindowRole): BrowserWindow {
    const title = role === "settings"
      ? "AG99live Settings"
      : role === "history"
        ? "AG99live History"
        : role === "action_lab"
          ? "AG99live Action Lab"
          : "AG99live Profile Editor";
    const width = role === "settings"
      ? 520
      : role === "history"
        ? 480
        : role === "action_lab"
          ? 940
          : 1180;
    const height = role === "settings"
      ? 700
      : role === "history"
        ? 680
        : role === "action_lab"
          ? 760
          : 860;
    const utilityWindow = new BrowserWindow({
      width,
      height,
      icon: APP_ICON_PATH,
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
      if (isSafeExternalLink(details.url)) {
        void shell.openExternal(details.url);
      } else {
        console.warn("[AG99live] Blocked external link with disallowed protocol.");
      }
      return { action: "deny" };
    });
  }

  private loadWindow(targetWindow: BrowserWindow, role: DesktopWindowRole): void {
    targetWindow.webContents.once("did-finish-load", () => {
      this.rendererReadyWindows.add(targetWindow);
      console.info(`[renderer] ready role=${role}`);
    });
    targetWindow.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL) => {
        console.error(
          `[renderer] load failed role=${role}: ${errorCode} ${errorDescription} ${validatedURL}`,
        );
      },
    );

    if (isDevelopment() && process.env.ELECTRON_RENDERER_URL) {
      const url = new URL(process.env.ELECTRON_RENDERER_URL);
      url.searchParams.set("window", role);
      void targetWindow.loadURL(url.toString()).catch((error: unknown) => {
        console.error(`[renderer] failed to load role=${role}.`, error);
      });
      return;
    }

    void targetWindow.loadFile(path.resolve(__dirname, "../renderer/index.html"), {
      query: { window: role },
    }).catch((error: unknown) => {
      console.error(`[renderer] failed to load role=${role}.`, error);
    });
  }

  private showWindowWhenReady(
    targetWindow: BrowserWindow | null,
    show: () => void,
  ): void {
    if (!targetWindow || targetWindow.isDestroyed()) {
      return;
    }

    if (this.rendererReadyWindows.has(targetWindow)) {
      show();
      return;
    }

    targetWindow.webContents.once("did-finish-load", show);
  }

  private showOverlayIfReady(): void {
    const petWindow = this.windows.pet;
    const overlayWindow = this.windows.overlay;
    if (
      !this.overlayVisiblePreference
      || !petWindow
      || petWindow.isDestroyed()
      || !petWindow.isVisible()
      || !overlayWindow
      || overlayWindow.isDestroyed()
      || !this.rendererReadyWindows.has(overlayWindow)
    ) {
      return;
    }

    this.positionOverlayWindow();
    overlayWindow.show();
  }

  private showSubtitleIfReady(): void {
    const petWindow = this.windows.pet;
    const subtitleWindow = this.windows.subtitle;
    if (
      !this.subtitleVisiblePreference
      || !petWindow
      || petWindow.isDestroyed()
      || !petWindow.isVisible()
      || !subtitleWindow
      || subtitleWindow.isDestroyed()
      || !this.rendererReadyWindows.has(subtitleWindow)
    ) {
      return;
    }

    subtitleWindow.show();
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
    const subtitleWindow = this.windows.subtitle;

    return {
      petBounds: petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null,
      overlayBounds: overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow.getBounds() : null,
      subtitleBounds: subtitleWindow && !subtitleWindow.isDestroyed() ? subtitleWindow.getBounds() : null,
      petVisible: Boolean(petWindow?.isVisible()),
      overlayVisible: Boolean(overlayWindow?.isVisible()),
      subtitleVisible: Boolean(subtitleWindow?.isVisible()),
      overlayVisiblePreference: this.overlayVisiblePreference,
      subtitleVisiblePreference: this.subtitleVisiblePreference,
      overlayFollowsPet: this.overlayFollowsPet,
      petIgnoreMouseEvents: this.petWindowIgnoreMouseEvents,
    };
  }

  private restoreTransparentWindowSnapshot(
    snapshot: TransparentWindowSnapshot,
    petWindow: BrowserWindow,
    overlayWindow: BrowserWindow,
    subtitleWindow: BrowserWindow,
  ): void {
    this.overlayVisiblePreference = snapshot.overlayVisiblePreference;
    this.subtitleVisiblePreference = snapshot.subtitleVisiblePreference;
    this.overlayFollowsPet = snapshot.overlayFollowsPet ?? true;
    this.petWindowIgnoreMouseEvents = snapshot.petIgnoreMouseEvents;

    if (snapshot.petBounds) {
      petWindow.setBounds(snapshot.petBounds, false);
    }
    this.normalizeTransparentWindowSize(petWindow, "pet");

    if (snapshot.overlayBounds) {
      overlayWindow.setBounds(snapshot.overlayBounds, false);
    } else if (this.overlayFollowsPet) {
      this.positionOverlayWindow();
    }
    this.normalizeTransparentWindowSize(overlayWindow, "overlay");

    if (snapshot.subtitleBounds) {
      subtitleWindow.setBounds(snapshot.subtitleBounds, false);
    }
    this.normalizeTransparentWindowSize(subtitleWindow, "subtitle");

    if (this.petWindowIgnoreMouseEvents) {
      petWindow.setIgnoreMouseEvents(true, { forward: true });
      this.keepPetWindowPassive(petWindow);
    } else {
      petWindow.setIgnoreMouseEvents(false);
    }

    if (snapshot.petVisible) {
      this.showWindowWhenReady(petWindow, () => {
        petWindow.show();
      });
    } else {
      petWindow.hide();
    }

    const shouldShowOverlay = snapshot.petVisible
      && snapshot.overlayVisible
      && snapshot.overlayVisiblePreference;

    if (shouldShowOverlay) {
      this.showWindowWhenReady(overlayWindow, () => {
        this.showOverlayIfReady();
      });
    } else {
      overlayWindow.hide();
    }

    const shouldShowSubtitle = snapshot.petVisible
      && snapshot.subtitleVisible
      && snapshot.subtitleVisiblePreference;

    if (shouldShowSubtitle) {
      this.showWindowWhenReady(subtitleWindow, () => {
        this.showSubtitleIfReady();
      });
    } else {
      subtitleWindow.hide();
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

    let x = petBounds.x + (petBounds.width - overlayWidth) / 2;

    const maxX = workArea.x + workArea.width - overlayWidth - PET_WINDOW_MARGIN;
    const minX = workArea.x + PET_WINDOW_MARGIN;
    x = Math.min(Math.max(x, minX), maxX);

    const belowY = petBounds.y + petBounds.height + PET_OVERLAY_GAP;
    const aboveY = petBounds.y - overlayHeight - PET_OVERLAY_GAP;
    const embeddedY = petBounds.y + petBounds.height - overlayHeight - 28;
    const maxY = workArea.y + workArea.height - overlayHeight - PET_WINDOW_MARGIN;
    const minY = workArea.y + PET_WINDOW_MARGIN;

    let y = embeddedY;
    if (belowY <= maxY) {
      y = belowY;
    } else if (aboveY >= minY) {
      y = aboveY;
    }
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

  private translateOverlayWindow(deltaX: number, deltaY: number): void {
    const overlayWindow = this.windows.overlay;
    if (
      !this.overlayFollowsPet
      || !overlayWindow
      || overlayWindow.isDestroyed()
      || !overlayWindow.isVisible()
    ) {
      return;
    }

    const [ox, oy] = overlayWindow.getPosition();
    overlayWindow.setPosition(ox + deltaX, oy + deltaY, false);
  }

  private normalizeTransparentWindowSize(
    targetWindow: BrowserWindow,
    role: DesktopWindowRole | null,
  ): boolean {
    if (
      targetWindow.isDestroyed()
      || (role !== "pet" && role !== "overlay" && role !== "subtitle")
    ) {
      return false;
    }

    if (role === "pet") {
      return false;
    }

    const bounds = targetWindow.getBounds();
    const expectedWidth = role === "overlay"
      ? PET_OVERLAY_WIDTH
      : PET_SUBTITLE_WIDTH;
    const expectedHeight = role === "overlay"
      ? PET_OVERLAY_HEIGHT
      : PET_SUBTITLE_HEIGHT;

    if (bounds.width === expectedWidth && bounds.height === expectedHeight) {
      return false;
    }

    targetWindow.setBounds(
      {
        ...bounds,
        width: expectedWidth,
        height: expectedHeight,
      },
      false,
    );

    if (this.activeDragState?.targetWindow === targetWindow) {
      this.activeDragState.lockedWidth = expectedWidth;
      this.activeDragState.lockedHeight = expectedHeight;
    }

    this.invalidateTransparentWindowSurface(targetWindow);
    return true;
  }

  private loadSubtitleVisiblePreference(): boolean {
    try {
      const raw = JSON.parse(readFileSync(this.subtitlePreferencePath, "utf8")) as unknown;
      if (
        raw
        && typeof raw === "object"
        && !Array.isArray(raw)
        && "visible" in raw
        && typeof raw.visible === "boolean"
      ) {
        return raw.visible;
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        console.warn("[window-preferences] failed to read subtitle preference; using enabled.", error);
      }
    }
    return true;
  }

  private persistSubtitleVisiblePreference(): void {
    try {
      mkdirSync(path.dirname(this.subtitlePreferencePath), { recursive: true });
      writeFileSync(
        this.subtitlePreferencePath,
        JSON.stringify({ visible: this.subtitleVisiblePreference }),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error) {
      console.warn("[window-preferences] failed to save subtitle preference.", error);
    }
  }

  private invalidateTransparentWindowSurface(targetWindow: BrowserWindow): void {
    // Windows can retain transparent pixels after resizing a frameless surface.
    setImmediate(() => {
      if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
        return;
      }
      targetWindow.webContents.invalidate();
    });
  }

  private flushDeferredTransparentWindowRecovery(): void {
    const reason = this.pendingTransparentWindowRecoveryReason;
    if (!reason) {
      return;
    }

    this.pendingTransparentWindowRecoveryReason = null;
    queueMicrotask(() => {
      if (this.activeDragState) {
        this.pendingTransparentWindowRecoveryReason = reason;
        return;
      }
      this.recoverTransparentWindows(`deferred after drag: ${reason}`);
    });
  }

  resetOverlayFollowMode(): void {
    this.overlayFollowsPet = true;
    this.positionOverlayWindow();
  }
}

function isMissingFile(error: unknown): boolean {
  return !!error
    && typeof error === "object"
    && "code" in error
    && error.code === "ENOENT";
}
