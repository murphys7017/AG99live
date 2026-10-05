import { app, BrowserWindow, ipcMain, Menu, screen, Tray } from "electron";
import path from "node:path";
import type { DesktopAuxWindowRole } from "../../src/types/desktop";
import { WindowManager } from "./window-manager";
import { WebControlLauncher } from "./web-control-launcher";

export class MenuManager {
  private readonly tray: Tray;

  constructor(
    private readonly windowManager: WindowManager,
    private readonly webControl: WebControlLauncher,
  ) {
    this.tray = new Tray(path.resolve(__dirname, "../../resources/app-icon.png"));
    this.tray.setToolTip("AG99live");
    this.tray.on("double-click", () => this.showPet());
    app.on("browser-window-created", (_event, window) => {
      const refresh = () => { setImmediate(() => this.refreshTrayMenu()); };
      window.on("show", refresh);
      window.on("hide", refresh);
      window.on("closed", refresh);
    });
    this.refreshTrayMenu();
    this.setupContextMenu();
  }

  dispose(): void {
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }

  private showPet(): void {
    const pet = this.windowManager.getWindow("pet");
    if (pet && !pet.isDestroyed()) {
      if (pet.isMinimized()) pet.restore();
      pet.show();
    }
  }

  private refreshTrayMenu(): void {
    if (!this.tray.isDestroyed()) {
      this.tray.setContextMenu(this.buildMenu());
    }
  }

  private buildMenu(): Menu {
    const petVisible = Boolean(this.windowManager.getWindow("pet")?.isVisible());
    return Menu.buildFromTemplate([
      {
        label: "打开 Web 控制面板",
        click: () => { void this.webControl.open(); },
      },
      { type: "separator" },
      {
        label: petVisible ? "隐藏桌宠" : "显示桌宠",
        click: () => {
          if (petVisible) this.windowManager.getWindow("pet")?.hide();
          else this.showPet();
        },
      },
      this.buildOverlayToggleItem(),
      this.buildOverlayReattachItem(),
      { type: "separator" },
      {
        label: "本机工具",
        submenu: [
          this.buildToggleItem("settings", "本机设置"),
          this.buildToggleItem("history", "对话历史"),
          this.buildToggleItem("action_lab", "动作实验室"),
        ],
      },
      { type: "separator" },
      { label: "退出 AG99live", click: () => app.quit() },
    ]);
  }

  private setupContextMenu(): void {
    ipcMain.on("desktop:show-context-menu", (event, position) => {
      const targetWindow = BrowserWindow.fromWebContents(event.sender);
      if (!targetWindow) {
        return;
      }

      const menu = this.buildMenu();

      const cursorPoint = screen.getCursorScreenPoint();
      const normalized = this.resolveMenuPosition(
        targetWindow,
        cursorPoint,
        position,
      );
      menu.popup({
        window: targetWindow,
        x: normalized.x,
        y: normalized.y,
      });
    });
  }

  private resolveMenuPosition(
    targetWindow: BrowserWindow,
    cursorPoint: { x: number; y: number },
    position: unknown,
  ): { x: number; y: number } {
    const bounds = targetWindow.getBounds();
    const payload = (position && typeof position === "object")
      ? (position as {
          x?: unknown;
          y?: unknown;
          screenX?: unknown;
          screenY?: unknown;
        })
      : {};

    const localX = this.toFiniteNumber(payload.x);
    const localY = this.toFiniteNumber(payload.y);
    if (localX !== null && localY !== null) {
      return {
        x: Math.max(0, Math.round(localX)),
        y: Math.max(0, Math.round(localY)),
      };
    }

    const screenX = this.toFiniteNumber(payload.screenX);
    const screenY = this.toFiniteNumber(payload.screenY);
    const fallbackScreenX = screenX ?? cursorPoint.x;
    const fallbackScreenY = screenY ?? cursorPoint.y;

    return {
      x: Math.max(0, Math.round(fallbackScreenX - bounds.x)),
      y: Math.max(0, Math.round(fallbackScreenY - bounds.y)),
    };
  }

  private toFiniteNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    return value;
  }

  private buildOverlayToggleItem() {
    const overlayWindow = this.windowManager.getOverlayWindow();
    const visible = Boolean(overlayWindow?.isVisible());

    return {
      label: visible ? "关闭输入框" : "打开输入框",
      click: () => {
        this.windowManager.toggleOverlayWindow();
      },
    };
  }

  private buildOverlayReattachItem() {
    return {
      label: "输入框恢复跟随",
      click: () => {
        this.windowManager.resetOverlayFollowMode();
      },
    };
  }

  private buildToggleItem(target: DesktopAuxWindowRole, label: string) {
    const targetWindow = this.windowManager.getAuxWindow(target);
    const visible = Boolean(targetWindow?.isVisible());

    return {
      label: visible ? `关闭${label}` : `打开${label}`,
      click: () => {
        this.windowManager.toggleAuxWindow(target);
      },
    };
  }
}
