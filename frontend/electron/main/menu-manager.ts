import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";
import type { DesktopAuxWindowRole } from "../../src/types/desktop";
import { WindowManager } from "./window-manager";

export class MenuManager {
  constructor(private readonly windowManager: WindowManager) {
    this.setupContextMenu();
  }

  private setupContextMenu(): void {
    ipcMain.on("desktop:show-context-menu", (event) => {
      const targetWindow = BrowserWindow.fromWebContents(event.sender);
      if (!targetWindow) {
        return;
      }

      const menu = Menu.buildFromTemplate([
        this.buildOverlayToggleItem(),
        this.buildToggleItem("settings", "系统设置"),
        this.buildToggleItem("history", "对话历史"),
        { type: "separator" },
        {
          label: "退出 AG99live",
          click: () => {
            app.quit();
          },
        },
      ]);

      const point = screen.getCursorScreenPoint();
      menu.popup({
        window: targetWindow,
        x: Math.round(point.x),
        y: Math.round(point.y),
      });
    });
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
