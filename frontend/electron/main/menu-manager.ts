import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";
import type { DesktopAuxWindowRole } from "../../src/types/desktop";
import { WindowManager } from "./window-manager";

export class MenuManager {
  constructor(private readonly windowManager: WindowManager) {
    this.setupContextMenu();
  }

  private setupContextMenu(): void {
    ipcMain.on("desktop:show-context-menu", (event, position) => {
      const targetWindow = BrowserWindow.fromWebContents(event.sender);
      if (!targetWindow) {
        return;
      }

      const menu = Menu.buildFromTemplate([
        this.buildOverlayToggleItem(),
        this.buildToggleItem("settings", "系统设置"),
        this.buildToggleItem("history", "对话历史"),
        this.buildToggleItem("action_lab", "动作实验室"),
        this.buildToggleItem("profile_editor", "Profile Editor"),
        { type: "separator" },
        {
          label: "退出 AG99live",
          click: () => {
            app.quit();
          },
        },
      ]);

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
