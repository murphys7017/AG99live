import type { DesktopPttKeyBinding } from "../types/desktop";
import { matchesPttKeyBinding } from "../adapter-connection/core/pttKeyBinding";

export interface PushToTalkAdapterPort {
  readonly state: {
    readonly pttModeEnabled: boolean;
    readonly pttKeyBinding: DesktopPttKeyBinding;
  };
  startPttCapture: () => Promise<void>;
  stopPttCapture: () => Promise<void>;
}

export interface PushToTalkController {
  install: () => void;
  dispose: () => void;
}

export function usePushToTalkController(adapter: PushToTalkAdapterPort): PushToTalkController {
  function onPttKeyDown(event: KeyboardEvent): void {
    console.info("[PTT] keydown key=%s repeat=%s pttMode=%s", event.key, event.repeat, adapter.state.pttModeEnabled);
    if (!adapter.state.pttModeEnabled) {
      return;
    }
    if (matchesPttKeyBinding(event, adapter.state.pttKeyBinding) && !event.repeat) {
      console.info("[PTT] starting mic capture");
      void adapter.startPttCapture();
    }
  }

  function onPttKeyUp(event: KeyboardEvent): void {
    console.info("[PTT] keyup key=%s pttMode=%s", event.key, adapter.state.pttModeEnabled);
    if (!adapter.state.pttModeEnabled) {
      return;
    }
    if (matchesPttKeyBinding(event, adapter.state.pttKeyBinding)) {
      console.info("[PTT] stopping mic capture");
      void adapter.stopPttCapture();
    }
  }

  function installPttKeyboardListeners(): void {
    document.addEventListener("keydown", onPttKeyDown);
    document.addEventListener("keyup", onPttKeyUp);
    window.addEventListener("keydown", onPttKeyDown);
    window.addEventListener("keyup", onPttKeyUp);
    console.info("[PTT] keyboard listeners installed (document + window)");
  }

  function removePttKeyboardListeners(): void {
    document.removeEventListener("keydown", onPttKeyDown);
    document.removeEventListener("keyup", onPttKeyUp);
    window.removeEventListener("keydown", onPttKeyDown);
    window.removeEventListener("keyup", onPttKeyUp);
  }

  function onPttIpcKeyDown(): void {
    if (!adapter.state.pttModeEnabled) {
      return;
    }
    console.info("[PTT] IPC keydown");
    void adapter.startPttCapture();
  }

  function onPttIpcKeyUp(): void {
    if (!adapter.state.pttModeEnabled) {
      return;
    }
    console.info("[PTT] IPC keyup");
    void adapter.stopPttCapture();
  }

  let detachPttIpcKeyDown: (() => void) | undefined;
  let detachPttIpcKeyUp: (() => void) | undefined;
  let installed = false;

  function installPttIpcListeners(): void {
    detachPttIpcKeyDown = window.ag99desktop?.onIpc?.("desktop:ptt-keydown", onPttIpcKeyDown);
    detachPttIpcKeyUp = window.ag99desktop?.onIpc?.("desktop:ptt-keyup", onPttIpcKeyUp);
  }

  function removePttIpcListeners(): void {
    detachPttIpcKeyDown?.();
    detachPttIpcKeyUp?.();
    detachPttIpcKeyDown = undefined;
    detachPttIpcKeyUp = undefined;
  }

  function install(): void {
    if (installed) {
      return;
    }
    installed = true;
    installPttKeyboardListeners();
    installPttIpcListeners();
  }

  function dispose(): void {
    if (!installed) {
      return;
    }
    installed = false;
    removePttKeyboardListeners();
    removePttIpcListeners();
  }

  return {
    install,
    dispose,
  };
}
